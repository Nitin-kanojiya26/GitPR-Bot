import { Queue } from "bullmq";
import Redis from "ioredis";

export interface ReviewJobData {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  installationId?: number;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";

// Redis connection instance required by BullMQ
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAME = "pr-reviews";

export const reviewQueue = new Queue<ReviewJobData>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

