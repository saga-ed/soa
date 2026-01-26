#!/bin/bash

echo "Testing tRPC API..."

echo "1. Health Check:"
curl -s -X GET http://localhost:5000/health | jq

echo -e "\n2. Create New Project:"
curl -s -X POST http://localhost:5000/saga-soa/v1/trpc/project.createProject \
  -H "Content-Type: application/json" \
  -d '{"name":"cURL Test Project","description":"Created via cURL","status":"active"}' | jq

echo -e "\n3. Get All Projects:"
curl -s -X GET http://localhost:5000/saga-soa/v1/trpc/project.getAllProjects | jq

echo -e "\n4. Get Project by ID:"
curl -s -X GET "http://localhost:5000/saga-soa/v1/trpc/project.getProjectById?input=%7B%22id%22%3A%221%22%7D" | jq

echo -e "\n5. Create New Run:"
curl -s -X POST http://localhost:5000/saga-soa/v1/trpc/run.createRun \
  -H "Content-Type: application/json" \
  -d '{"projectId":"1","name":"cURL Test Run","description":"Created via cURL","status":"pending"}' | jq

echo -e "\n6. Get All Runs:"
curl -s -X GET http://localhost:5000/saga-soa/v1/trpc/run.getAllRuns | jq

echo -e "\n7. Get Run by ID:"
curl -s -X GET "http://localhost:5000/saga-soa/v1/trpc/run.getRunById?input=%7B%22id%22%3A%221%22%7D" | jq

echo -e "\n8. Test Error - Invalid Project ID:"
curl -s -X GET "http://localhost:5000/saga-soa/v1/trpc/project.getProjectById?input=%7B%22id%22%3A%22999%22%7D" | jq

echo -e "\n9. Test Error - Invalid Input:"
curl -s -X POST http://localhost:5000/saga-soa/v1/trpc/project.createProject \
  -H "Content-Type: application/json" \
  -d '{}' | jq

echo -e "\nTest completed!" 