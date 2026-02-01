import { Field, ObjectType, ID, Int } from 'type-graphql';

@ObjectType()
export class Session {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  tutor!: string;

  @Field(() => String)
  student!: string;

  @Field(() => Date)
  date!: Date;

  @Field(() => Int)
  duration!: number; // in minutes

  @Field(() => String, { nullable: true })
  notes?: string;
}
