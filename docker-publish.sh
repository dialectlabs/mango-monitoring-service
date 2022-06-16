package_version=$(jq -r .version package.json)

docker push dialectlab/mango-monitoring-service:"$package_version"
docker push dialectlab/mango-monitoring-service:latest