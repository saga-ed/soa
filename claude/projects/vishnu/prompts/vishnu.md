I would like to build a saga-mesh visualization and diagnostic viewer

The system will represent saga systems (apis), applications, data systems and the enviornment in which they run using a block digramatic graph arranged left to right (data system) ->  saga-mesh -> saga-applications.

I would like the routing to connecting the system to represent both point to point connections over tRPC, REST etc and connections via the RabbitMQ bus and projective tables

The lines should route as rectangulary as possible with soft corners (give them a radius)

The thinkness of the lines should represent the number of endpoints of the number of distinct events too and from the bus - The intensity of the color should represent the rate of the data flowing along the line (how many events or tRPC requests pers second)

There are also scalers associated with the blocks (i.e. how many errors is a system generated - so we will need some method to represent scalar data from blocks

The idea is I can visual then entire mesh in real time and zoom in of filter the view down to a system that I'm interseted in - then click down into say a particular scalar or connection to get more information - The data for the view can be build largely on datadog APM and logging as will as RUM events from the applications - pulling data directly from the systems or services or compute substrates if datadog does not carry the data we need to successfulling implement this comprehensive view of the health of the system

Please introspect the saga mesh, it AWS enviornment upon which it runs, the existing triage and access skills for databases and systems - The local environment (synthetic-dev) as well as our pre-production dev environment (wootdev) and finally the production mesh

I want to be able to point the tools called vishnu to any of the environment in which the mesh runs

The idea with this system is I want to quickly be able to identify systems that are in trouble or hot data paths and slow connections
