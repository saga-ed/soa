import { Field, InputType } from 'type-graphql';

@InputType()
export class UserInput {
  @Field(() => String)
  name!: string;

  @Field(() => String)
  email!: string;

  @Field(() => String, { nullable: true })
  role?: string;
}
