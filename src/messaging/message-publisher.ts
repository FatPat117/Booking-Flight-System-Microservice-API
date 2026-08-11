/**
 * Gửi một message tới một đích cụ thể (queue/topic), không quan tâm ai sẽ nhận.
 * KHÔNG được biết về AMQP, RabbitMQ, hay bất kỳ chi tiết giao thức nào.
 */
export type MessagePublisher = Readonly<{
  publish(destination: string, message: unknown): Promise<void>;
  close(): Promise<void>;
}>;