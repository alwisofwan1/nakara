import { now, Repository } from "./repository.ts";

export interface Message {
  id: number;
  item_id: number;
  author: "factory" | "human";
  body: string;
  created_at: string;
}

/** Reads and writes the messages table: a work item's conversation. */
export class MessageRepository extends Repository {
  addMessage(itemId: number, author: Message["author"], body: string): void {
    this.run(
      "INSERT INTO messages (item_id, author, body, created_at) VALUES (?, ?, ?, ?)",
      itemId,
      author,
      body,
      now(),
    );
    // Messages feed a work item's conversation and the Inbox's recent events.
    this.notifier.notify({ type: "items", id: "global" });
  }

  /** Factory messages after a cursor, for outbound notifications. */
  factoryMessagesAfter(id: number): Message[] {
    return this.all<Message>(
      "SELECT * FROM messages WHERE id > ? AND author = 'factory' ORDER BY id LIMIT 20",
      id,
    );
  }

  lastMessageId(): number {
    return (
      this.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")
        ?.id ?? 0
    );
  }

  messages(itemId: number): Message[] {
    return this.all<Message>(
      "SELECT * FROM messages WHERE item_id = ? ORDER BY id",
      itemId,
    );
  }
}
