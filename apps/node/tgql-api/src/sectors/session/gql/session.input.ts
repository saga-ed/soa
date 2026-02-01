import { Field, InputType, Int } from 'type-graphql';

@InputType()
export class SessionInput {
  @Field(() => String)
  tutor!: string;

  @Field(() => String)
  student!: string;

  @Field(() => Date)
  date!: Date;

  @Field(() => Int)
  duration!: number;

  @Field(() => String, { nullable: true })
  notes?: string;
}
