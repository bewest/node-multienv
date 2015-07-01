FROM ubuntu:trusty
MAINTAINER Ben West <bewest@gmail.com>

ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update -y
RUN apt-get install -y wget curl git -y
RUN curl -sL https://deb.nodesource.com/setup_dev | sudo bash -
RUN apt-get install -y nodejs build-essential nginx

ADD . /app

WORKDIR /app

EXPOSE 80
EXPOSE 3434
RUN /app/setup_docker_guest.sh
CMD /app/start_container.sh
