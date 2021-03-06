package_version=$(jq -r .version package.json)

docker build --platform linux/amd64 \
  -t dialectlab/mango-monitoring-service:"$package_version" \
  -t dialectlab/mango-monitoring-service:latest .