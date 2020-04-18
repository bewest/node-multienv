FROM ubuntu:bionic
MAINTAINER Ben West <bewest@gmail.com>

ENV DEBIAN_FRONTEND noninteractive


RUN apt-get update -y
RUN apt-get install -y wget curl git sudo -y
RUN curl -sL https://deb.nodesource.com/setup_10.x | bash -

RUN apt-get install -y python software-properties-common nodejs build-essential nginx ruby dnsutils
# forward request and error logs to docker log collector
RUN ln -sf /dev/stdout /var/log/nginx/access.log
RUN ln -sf /dev/stdout /var/log/nginx/error.log


RUN apt-get install -y mongodb rsyslog
RUN npm install -g n
RUN n prune
RUN n 10

# RUN npm cache-clean -g npm
# RUN npm install -g npm
# RUN npm update -g npm
# RUN curl -0 -L https://npmjs.com/install.sh | bash
# RUN npm install -g node-gyp

# COPY package.json /home/app/package.json
# RUN cd /home/app && npm install

RUN useradd --user-group --create-home \
            --groups adm,sudo \
            --shell /bin/bash       \
            --no-log-init --system  \
            app

RUN mkdir -p /opt/multi && chown app /opt/multi
ADD . /app

# VOLUME ["/etc/nginx", "/app"]

WORKDIR /app

EXPOSE 4545
EXPOSE 3434

# USER app
RUN /app/setup_docker_guest.sh

CMD /app/start_container.sh
