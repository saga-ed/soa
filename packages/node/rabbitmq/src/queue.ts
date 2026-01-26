import { Options } from "amqplib";

export interface QueueDefinition {
  name: string;
  options: Options.AssertQueue;
}