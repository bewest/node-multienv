FROM ubuntu:focal
MAINTAINER Ben West <bewest@gmail.com>

ENV DEBIAN_FRONTEND noninteractive
ENV NODE_MAJOR=16

RUN apt-get update -y && apt-get install -y ca-certificates gnupg wget curl git sudo

RUN sudo mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list


RUN apt-get update && apt-get install -y python software-properties-common nodejs build-essential nginx ruby dnsutils
# forward request and error logs to docker log collector
RUN ln -sf /dev/stdout /var/log/nginx/access.log
RUN ln -sf /dev/stdout /var/log/nginx/error.log


RUN apt-get install -y mongodb rsyslog
RUN npm install -g n
RUN n prune
RUN n 16

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
EXPOSE 3535
EXPOSE 3434

# USER app
RUN /app/setup_docker_guest.sh

# CMD /app/start_container.sh
ENTRYPOINT ["/app/start_container.sh"]
CMD ["multienv"]
