#!/bin/bash

echo starting container...
whoami
pwd
env
ls -alh /etc/nginx
export INTERNAL_PORT=3434
export PORT=80

erb nginx.conf.erb | tee /etc/nginx/nginx.conf
service nginx restart

node master.js

