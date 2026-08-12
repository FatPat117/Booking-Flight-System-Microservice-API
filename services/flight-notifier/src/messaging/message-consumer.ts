/**
 * Kết quả xử lý một message — quyết định consumer nên ack hay nack.
 */
export type MessageHandlerResult =
  | { outcome: "processed" }
  | { outcome: "rejected"; reason: string };

export type MessageHandler = (
  payload: unknown,
) => Promise<MessageHandlerResult>;

/**
 * Lắng nghe một nguồn message (queue/topic) và gọi handler cho mỗi message.
 */
export type MessageConsumer = Readonly<{
  subscribe(source: string, handler: MessageHandler): Promise<void>;
  close(): Promise<void>;
}>;
