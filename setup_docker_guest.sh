#!/bin/bash

echo setup docker

pwd
mkdir -p /opt/multi/working/{environments,workdir}

(
rm -Rf node_modules
npm install
)

echo "getting done with setup"

