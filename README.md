### `multienv` server

Manage many unique environments for a single tenant server.

## Install

Clone this repo, then: `npm install`

## Running `node master.js`
Running `node master.js` will start a REST API to manage a single tenant process.

### Environment variables

These define how `multienv` will work:

#### `PORT`
> Default: `3434`

The port on which to host the builtin `REST` API.

#### `HOSTEDPORTS`
> Default: `5000`

`multienv` will create many processes, each bound to a new port.
Port assignment will take place by defining the `PORT` variable for each new process.
The port variable assigned to each process is `HOSTEDPORTS` incremented by one
every time a new process is created.



#### `WORKER_ENV`
> Default: `./envs`

`WORKER_ENV` should be a directory.  `multienv` will monitor this directory for
any changes.  Each file represents the unique environment variables defined for
each managed process.  **Added**, **Updated**, or **Removed** from `WORKER_ENV`
represents a process which `multienv` will **create**, **restart**, or
**kill**, respectively.

* **add file** - **create**s, or add a new process with a new config
* **change file** - **restart**s, or update a process with a new config
* **remove file** - **kill**s, or deletes an process


Here is an example `.env` file:
```
CUSTOMCONNSTR_mongo_collection=myentries
MONGO_CONNECTION=mongodb://localhost/mytest
RES=7
```

Eg, the file can be sourced in bash to set environment variables in an active
shell from a file `local.env` with the above contents using `. local.env`.

#### `WORKER_DIR`
> Default: `../cgm-remote-monitor`

`WORKER_DIR` should be a path to a directory.  The directory should the root of
a node js application with a file called `server.js`.  For each **environment**
`multienv` knows about, it will start `node server.js` with those environment
variables defined.  Eg, for an env file called `local.env`, this would be
similar to running `(cd $WORKER_DIR ; . $WORKER_ENV/local.env; node server.js)`,
but all files in `$WORKER_DIR`.

### Behavior
If `WORKER_DIR`'s application fails, `multienv` will try to restart it up to 4
times, and then gives up.

## REST API

There's a built-in REST API, of course, to manage basic CRUD operations.  The
REST API edits and lists the `*.env` text files in `WORKER_ENV`.  It can also
select them by name, or by running cluster id.  It can also create new
environments, which cause new processes to start.

### **GET** `/cluster`
`/cluster` returns a json description of all currently running processes.

### **GET** `/cluster/:id`
`/cluster/:id`  Returns details of process by `id`.
### **GET** `/history`
`/history`
`/cluster` returns a json description of all processes seen by `metaenvdir`.
### **GET** `/environs`
`/environs` returns a json description of all environments found in `WORKER_ENV`.
### **GET** `/environs/:name`
`/environs/:name` returns a json description of environment by `name`.  This is
the name of the environment file relative to `WORKER_ENV`, sans `.env`
extension.
### **POST** `/environs/:name`
**POST** a json object to define a new environment.
`/environs/:name` returns a json description of environment by `name`.
This is the name of the environment file relative to `WORKER_ENV`, sans `.env`
extension.
Returns new environment variables as a json object.
### **DELETE** `/environs/:name`
`/environs/:name` - Delete (and stop a running process for) an environment.
This is the name of the environment file relative to `WORKER_ENV`, sans `.env`
extension.
### **GET** `/environs/:name/env`
`/environs/:name/env`
This is the `name` of the environment file relative to `WORKER_ENV`, sans
`.env` extension.
Get environment variables as a json object.
### **GET** `/environs/:name/env/:field`
`/environs/:name/env/:field` - retrieve value of a single environment variable.
This is the `name` of the environment file relative to `WORKER_ENV`, sans
`.env` extension.
The `field` is the name of the single environment variable.

