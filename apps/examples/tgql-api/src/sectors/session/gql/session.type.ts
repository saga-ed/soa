import { Field, ObjectType, ID, Int } from 'type-graphql';

@ObjectType()
export class Session {
  @Field(() => ID)
  id!: string;

  @Field()
  tutor!: string;

  @Field()
  student!: string;

  @Field()
  date!: Date;

  @Field(() => Int)
  duration!: number; // in minutes

  @Field({ nullable: true })
  notes?: string;
}
