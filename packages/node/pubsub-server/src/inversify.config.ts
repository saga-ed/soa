import { Container } from 'inversify';
import { TYPES } from './types/index.js';
import { PubSubService } from './services/pubsub.service.js';
import { EventService } from './services/event.service.js';
import { ChannelService } from './services/channel.service.js';

// Create the container
const container = new Container();

// Bind services
container.bind<PubSubService>(TYPES.PubSubService).to(PubSubService);
container.bind<EventService>(TYPES.EventService).to(EventService);
container.bind<ChannelService>(TYPES.ChannelService).to(ChannelService);

// Note: PubSubAdapter and Logger will be bound by the consumer
// as they are external dependencies

export { container }; 