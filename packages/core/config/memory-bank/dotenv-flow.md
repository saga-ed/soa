#### Background

This module should provide boilderplate support for dotenv-flow based configuration flow that uses zod for runtime validation of before returning a strongly typed configuration blob.

Clients of this package should be able to provide a zod schema to express schema contraints use zod type inference to define the type of the configuration blob.

All config objects should have a config_name for example MongoConnection

Here is an example for MongoDB connection

```

const MongoConnectionSchema = z.object({

  config_name: z.string(),

  host: z.string()
    .min(1, "Host cannot be empty")
    .max(255, "Host name too long")
    .regex(/^[a-zA-Z0-9.-]+$/, "Host contains invalid characters"),

  port: z.number()
    .int("Port must be an integer")
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),

  database: z.string()
    .min(1, "Database name cannot be empty")
    .max(64, "Database name too long")
    .regex(/^[a-zA-Z0-9_-]+$/, "Database name contains invalid characters"),

  username: z.string()
    .min(1, "Username cannot be empty")
    .max(32, "Username too long")
    .regex(/^[a-zA-Z0-9_-]+$/, "Username contains invalid characters")
    .optional(),

  password: z.string()
    .min(1, "Password cannot be empty")
    .max(128, "Password too long")
    .optional(),

  authSource: z.string()Here is an example of a Mongo DB interface for a connection to an instance
    .min(1, "Auth source cannot be empty")
    .max(64, "Auth source name too long")
    .regex(/^[a-zA-Z0-9_-]+$/, "Auth source contains invalid characters")
    .default("admin")
});

// Type can be inferred from the schema
type MongoConnectionConfig = z.infer<typeof MongoConnectionSchema>;
```

The configuration manager class should implement the below method

```
// Implicitly has type MongoConnectionConfig
const mongo_config = ConfigManager.get<MongoConnectionSchema>
```

#### Details

Under the hood this code use dotenv-flow to initialize the environment dotenv-flow to initialize the environment and provides a method to access the parsed env blob

0. dotenv-flow to initialize the environment
1. create a input object by matching env data with the fields named in the schema using an upper-snake prefex based on the configuration name

// env variable
MONGO_CONNECTION.host

// input object
{
host: 'localhost'
}

2. parse and return the infered object using using the schema.parse

3. throw a named exception type either custom or a zod error type to describe the error if parse fails

### Some questions

1. Can I use a generic type generate the nested type definiton

class ConfigManager<MongoConnnectionSchema> {
type MongoConnectionConfig = z.infer<typeof MongoConnectionSchema>
}

2. Can I constrain the Blah type to be a zod schema object with the required stringofied field config_name
