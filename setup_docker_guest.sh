#!/bin/bash

echo setup docker

cat <<EOF
# | tee /etc/apt/sources.list.d/nginx.list
deb http://ppa.launchpad.net/nginx/stable/ubuntu trusty main 
deb-src http://ppa.launchpad.net/nginx/stable/ubuntu trusty main 
EOF

# apt-key  adv --keyserver keyserver.ubuntu.com --recv-keys C300EE8C

# apt-get update
# apt-get install -y nodejs build-essential nginx ruby
pwd
mkdir -p /opt/multi/working/{environments,workdir}

echo "getting done with setup"

