import { Field, InputType, Int } from 'type-graphql';

@InputType()
export class SessionInput {
  @Field()
  tutor!: string;

  @Field()
  student!: string;

  @Field()
  date!: Date;

  @Field(() => Int)
  duration!: number;

  @Field({ nullable: true })
  notes?: string;
}
