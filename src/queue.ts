import 'dotenv/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
export const notificationQueue = new Queue('referral-notifications', { connection: redis });

export async function enqueueNotification(notificationId: string, scheduledAt: Date) {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  const jobId = `notification-${notificationId}`;
  try {
    await notificationQueue.add('send-notification', { notificationId }, { jobId, delay, attempts: 3, backoff: { type: 'fixed', delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 });
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'notification-queue',
      event: 'notification.enqueue_failed',
      queue: notificationQueue.name,
      queueJobId: jobId,
      notificationId,
      scheduledAtUtc: scheduledAt.toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }));
    throw error;
  }
}
