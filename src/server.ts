import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma } from './db.js';
import { enqueueNotification, notificationQueue } from './queue.js';
import { localDayEnd, localDayKeyToUtcDate, localJobDate, scheduleSameDay } from './time.js';

const app = Fastify({ logger: true });
const jobInput = z.object({ title: z.string().min(1), company: z.string().min(1), location: z.string().optional(), jobUrl: z.string().url(), source: z.string().min(1), linkedinUrl: z.string().url().optional(), logoUrl: z.string().url().optional() });
const authInput = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1).optional(), timezone: z.string().optional() });
app.register(cors, { origin: true, credentials: true });
app.register(cookie);
app.register(jwt, { secret: process.env.AUTH_SECRET ?? 'development-only-change-me', cookie: { cookieName: 'rf_token', signed: false } });
app.setErrorHandler((error, request, reply) => {
  if ((error as { code?: string }).code === 'P2002') return reply.code(409).send({ error: 'Job already tracked' });
  request.log.error(error);
  return reply.code(500).send({ error: 'Unable to save this opportunity' });
});

async function authenticatedUser(request: any, reply: any) {
  try {
    await request.jwtVerify();
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user) throw new Error('User not found');
    return user;
  } catch {
    reply.code(401).send({ error: 'Authentication required' });
    return null;
  }
}

function setAuthCookie(reply: any, token: string) {
  reply.setCookie('rf_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 });
}

app.get('/health', async () => ({ ok: true, service: 'referral-first-api' }));

app.get('/queue/status', async (request, reply) => {
  // const user = await authenticatedUser(request, reply);
  // if (!user) return;
  const counts = await notificationQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
  const jobs = await notificationQueue.getJobs(['waiting', 'active', 'delayed', 'failed'], 0, 49, true);
  return {
    queue: notificationQueue.name,
    counts,
    jobs: jobs.map(job => ({
      id: job.id,
      name: job.name,
      state: job.failedReason ? 'failed' : job.finishedOn ? 'completed' : job.processedOn ? 'active' : 'queued',
      notificationId: (job.data as { notificationId?: string }).notificationId,
      delayUntil: job.timestamp + job.delay,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason
    }))
  };
});

app.post('/auth/register', async (request, reply) => {
  const input = authInput.parse(request.body);
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ error: 'Email is already registered' });
  const timezone = input.timezone ?? process.env.DEFAULT_TIMEZONE ?? 'UTC';
  const user = await prisma.user.create({ data: { email, name: input.name ?? email.split('@')[0], passwordHash: await bcrypt.hash(input.password, 12), timezone } });
  setAuthCookie(reply, app.jwt.sign({ sub: user.id, email: user.email }));
  return reply.code(201).send({ id: user.id, email: user.email, name: user.name, timezone: user.timezone });
});

app.post('/auth/login', async (request, reply) => {
  const input = authInput.omit({ name: true }).parse(request.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user || !user.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) return reply.code(401).send({ error: 'Invalid email or password' });
  if (input.timezone && user.timezone !== input.timezone) {
    await prisma.user.update({ where: { id: user.id }, data: { timezone: input.timezone } });
  }
  setAuthCookie(reply, app.jwt.sign({ sub: user.id, email: user.email }));
  return { id: user.id, email: user.email, name: user.name, timezone: input.timezone ?? user.timezone };
});

app.post('/auth/logout', async (_request, reply) => { reply.clearCookie('rf_token', { path: '/' }); return { ok: true }; });
app.get('/auth/me', async (request, reply) => {
  const user = await authenticatedUser(request, reply);
  if (!user) return undefined;
  const browserTimezone = request.headers['x-timezone'];
  if (typeof browserTimezone === 'string' && browserTimezone.length >= 2 && browserTimezone !== user.timezone) {
    await prisma.user.update({ where: { id: user.id }, data: { timezone: browserTimezone } });
    user.timezone = browserTimezone;
  }
  return { id: user.id, email: user.email, name: user.name, timezone: user.timezone };
});

app.get('/jobs', async (request, reply) => {
  const query = z.object({ view: z.enum(['today', 'archive']).default('today') }).parse(request.query);
  const user = await authenticatedUser(request, reply);
  if (!user) return [];
  const today = localJobDate(user.timezone);
  const todayUtc = localDayKeyToUtcDate(today);
  const nextUtcDate = localDayKeyToUtcDate(new Date(Date.UTC(new Date(todayUtc).getUTCFullYear(), new Date(todayUtc).getUTCMonth(), new Date(todayUtc).getUTCDate() + 1)).toISOString().slice(0, 10));
  return prisma.job.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(query.view === 'today' ? { jobDate: { gte: todayUtc, lt: nextUtcDate } } : { jobDate: { lt: todayUtc } })
    },
    include: { company: true },
    orderBy: { createdAt: 'desc' }
  });
});

app.post('/jobs', async (request, reply) => {
  const input = jobInput.parse(request.body);
  const user = await authenticatedUser(request, reply);
  if (!user) return reply.code(401).send({ error: 'Authentication required' });
  const normalizedJobUrl = new URL(input.jobUrl).toString().replace(/\/$/, '').toLowerCase();
  const existingJob = await prisma.job.findFirst({ where: { userId: user.id, normalizedJobUrl } });
  if (existingJob && !existingJob.deletedAt) return reply.code(409).send({ error: 'Job already tracked' });
  const company = await prisma.company.upsert({ where: { id: `${user.id}:${input.company.toLowerCase()}` }, update: { linkedinUrl: input.linkedinUrl, logoUrl: input.logoUrl }, create: { id: `${user.id}:${input.company.toLowerCase()}`, name: input.company, linkedinUrl: input.linkedinUrl, logoUrl: input.logoUrl } });
  const jobDate = localDayKeyToUtcDate(localJobDate(user.timezone));
  if (existingJob) {
    await prisma.notification.updateMany({ where: { jobId: existingJob.id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
    const restoredJob = await prisma.job.update({
      where: { id: existingJob.id },
      data: {
        companyId: company.id,
        title: input.title,
        location: input.location,
        jobUrl: input.jobUrl,
        source: input.source,
        jobDate,
        referralStatus: 'NOT_REQUESTED',
        referralRequestedAt: null,
        referralReceivedAt: null,
        nextFollowUpAt: null,
        applyDirectNotificationAt: null,
        applyDirectNotificationSentAt: null,
        deletedAt: null
      },
      include: { company: true }
    });
    return restoredJob;
  }
  const job = await prisma.job.create({ data: { userId: user.id, companyId: company.id, title: input.title, location: input.location, jobUrl: input.jobUrl, normalizedJobUrl, source: input.source, jobDate }, include: { company: true } });
  return reply.code(201).send(job);
});

app.post('/jobs/:id/referral/request', async (request, reply) => {
  const user = await authenticatedUser(request, reply);
  const job = user ? await prisma.job.findFirst({ where: { id: (request.params as { id: string }).id, userId: user.id, deletedAt: null } }) : null;
  if (!user || !job) return reply.code(404).send({ error: 'Job not found' });
  if (job.referralStatus !== 'NOT_REQUESTED') return reply.code(409).send({ error: 'Referral has already been requested' });
  const now = new Date();
  const followUpAt = scheduleSameDay(now, user.followUpIntervalMinutes / 60, user.timezone);
  const applyDirectAt = scheduleSameDay(now, user.applyDirectDelayMinutes / 60, user.timezone);
  const updated = await prisma.job.update({ where: { id: job.id }, data: { referralStatus: 'REQUESTED', referralRequestedAt: now, nextFollowUpAt: followUpAt, applyDirectNotificationAt: applyDirectAt }, include: { company: true } });
  if (followUpAt) { const notification = await prisma.notification.create({ data: { userId: user.id, jobId: job.id, type: 'FOLLOW_UP', scheduledAt: followUpAt } }); await enqueueNotification(notification.id, followUpAt); }
  if (applyDirectAt) { const notification = await prisma.notification.create({ data: { userId: user.id, jobId: job.id, type: 'APPLY_DIRECTLY', scheduledAt: applyDirectAt } }); await enqueueNotification(notification.id, applyDirectAt); }
  return updated;
});

app.post('/jobs/:id/referral/received', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const user = await authenticatedUser(request, reply);
  const job = user ? await prisma.job.findFirst({ where: { id, userId: user.id, deletedAt: null } }) : null;
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  const updated = await prisma.job.update({ where: { id }, data: { referralStatus: 'RECEIVED', referralReceivedAt: new Date(), nextFollowUpAt: null, applyDirectNotificationAt: null }, include: { company: true } });
  await prisma.notification.updateMany({ where: { jobId: id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  return updated;
});

app.patch('/jobs/:id/status', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = z.object({ status: z.enum(['NOT_REQUESTED', 'REQUESTED', 'RECEIVED']) }).parse(request.body);
  const user = await authenticatedUser(request, reply);
  const job = user ? await prisma.job.findFirst({ where: { id, userId: user.id, deletedAt: null } }) : null;
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  if (body.status !== 'NOT_REQUESTED') return reply.code(400).send({ error: 'Use the referral transition endpoints for this status' });
  await prisma.notification.updateMany({ where: { jobId: id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  return prisma.job.update({ where: { id }, data: { referralStatus: 'NOT_REQUESTED', referralRequestedAt: null, referralReceivedAt: null, nextFollowUpAt: null, applyDirectNotificationAt: null, applyDirectNotificationSentAt: null }, include: { company: true } });
});

app.delete('/jobs/:id', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const user = await authenticatedUser(request, reply);
  if (!user) return;
  const job = await prisma.job.findFirst({ where: { id, userId: user.id, deletedAt: null } });
  if (!job) return { ok: true, alreadyRemoved: true };
  await prisma.notification.updateMany({ where: { jobId: id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  await prisma.job.update({ where: { id }, data: { deletedAt: new Date(), nextFollowUpAt: null, applyDirectNotificationAt: null } });
  return { ok: true };
});

app.get('/notifications', async (request, reply) => {
  const user = await authenticatedUser(request, reply);
  if (!user) return [];
  const today = localJobDate(user.timezone);
  const todayUtc = localDayKeyToUtcDate(today);
  const nextDayUtc = localDayKeyToUtcDate(DateTime.fromISO(today).plus({ days: 1 }).toISODate()!);
  return prisma.notification.findMany({
    where: {
      userId: user.id,
      status: { in: ['SCHEDULED', 'SENT'] },
      job: {
        deletedAt: null,
        referralStatus: 'REQUESTED',
        jobDate: { gte: todayUtc, lt: nextDayUtc }
      }
    },
    include: { job: { include: { company: true } } },
    orderBy: { scheduledAt: 'asc' }
  });
});

app.get('/settings', async (request, reply) => {
  const user = await authenticatedUser(request, reply);
  return user ? { followUpHours: user.followUpIntervalMinutes / 60, applyDirectHours: user.applyDirectDelayMinutes / 60, timezone: user.timezone } : undefined;
});

app.post('/jobs/:id/apply-direct/handled', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const user = await authenticatedUser(request, reply);
  const job = user ? await prisma.job.findFirst({ where: { id, userId: user.id, deletedAt: null } }) : null;
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return prisma.job.update({ where: { id }, data: { applyDirectNotificationSentAt: new Date() }, include: { company: true } });
});

app.patch('/settings', async (request, reply) => {
  const input = z.object({ followUpHours: z.number().positive(), applyDirectHours: z.number().positive(), timezone: z.string().min(2).optional() }).parse(request.body);
  const user = await authenticatedUser(request, reply);
  if (!user) return;
  const followUpIntervalMinutes = Math.max(1, Math.round(input.followUpHours * 60));
  const applyDirectDelayMinutes = Math.max(1, Math.round(input.applyDirectHours * 60));
  const timezone = input.timezone ?? user.timezone;
  await prisma.user.update({ where: { id: user.id }, data: { followUpIntervalMinutes, applyDirectDelayMinutes, timezone } });

  const today = localJobDate(timezone);
  const todayUtc = localDayKeyToUtcDate(today);
  const nextDayUtc = localDayKeyToUtcDate(DateTime.fromISO(today).plus({ days: 1 }).toISODate()!);
  const requestedJobs = await prisma.job.findMany({ where: { userId: user.id, deletedAt: null, referralStatus: 'REQUESTED', jobDate: { gte: todayUtc, lt: nextDayUtc } } });
  for (const job of requestedJobs) {
    await prisma.notification.updateMany({ where: { jobId: job.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    const now = new Date();
    const nextFollowUpAt = scheduleSameDay(now, followUpIntervalMinutes / 60, timezone);
    const applyDirectAt = job.applyDirectNotificationSentAt ? null : scheduleSameDay(now, applyDirectDelayMinutes / 60, timezone);
    await prisma.job.update({ where: { id: job.id }, data: { nextFollowUpAt, applyDirectNotificationAt: applyDirectAt } });
    if (nextFollowUpAt) {
      const notification = await prisma.notification.create({ data: { userId: user.id, jobId: job.id, type: 'FOLLOW_UP', scheduledAt: nextFollowUpAt } });
      await enqueueNotification(notification.id, nextFollowUpAt);
    }
    if (applyDirectAt) {
      const notification = await prisma.notification.create({ data: { userId: user.id, jobId: job.id, type: 'APPLY_DIRECTLY', scheduledAt: applyDirectAt } });
      await enqueueNotification(notification.id, applyDirectAt);
    }
  }
  return { followUpHours: followUpIntervalMinutes / 60, applyDirectHours: applyDirectDelayMinutes / 60, timezone };
});

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' })
  .catch((error: unknown) => { app.log.error(error); process.exit(1); });
