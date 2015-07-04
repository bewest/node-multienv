FROM ubuntu:trusty
MAINTAINER Ben West <bewest@gmail.com>

ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update -y
RUN apt-get install -y wget curl git -y
RUN curl -sL https://deb.nodesource.com/setup_dev | sudo bash -

RUN echo "deb http://ppa.launchpad.net/nginx/stable/ubuntu trusty main" | tee /etc/apt/sources.list.d/nginx.list
RUN echo "deb-src http://ppa.launchpad.net/nginx/stable/ubuntu trusty main" | tee /etc/apt/sources.list.d/nginx.list
RUN apt-key  adv --keyserver keyserver.ubuntu.com --recv-keys C300EE8C
RUN apt-get update
RUN apt-get install -y python python-software-properties nodejs build-essential nginx ruby
RUN npm install -g node-gyp

ADD . /app

WORKDIR /app

EXPOSE 80
EXPOSE 3434
RUN /app/setup_docker_guest.sh
CMD /app/start_container.sh
