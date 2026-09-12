# ChartDB viewer

A read-only diagram of a SQL schema file that updates on save. No database
connection is required, so it can preview changes before migrations run.

## Run

Mount the directory containing `schema.sql`, so atomic editor saves remain visible.
This example uses `./api/schema.sql`; replace `$PWD/api` with your schema directory:

```sh
docker run --rm -p 127.0.0.1:8080:80 \
  -e SCHEMA_DIALECT=postgresql \
  -v "$PWD/api:/schema:ro" \
  ghcr.io/arnavdugar/chartdb-viewer:latest
```

Open [localhost:8080](http://localhost:8080).

Only `schema.sql` is exposed from the mount. Analytics are disabled.

## SQL dialect

You must set `SCHEMA_DIALECT` when starting the container to select the SQL
importer. There is no default:

| Value         | Importer                  |
| ------------- | ------------------------- |
| `postgresql`  | PostgreSQL                |
| `mysql`       | MySQL                     |
| `mariadb`     | MySQL-compatible SQL      |
| `sqlite`      | SQLite                    |
| `sql_server`  | Microsoft SQL Server      |
| `oracle`      | Oracle                    |
| `cockroachdb` | PostgreSQL-compatible SQL |

## Build

```sh
docker build -t chartdb-viewer:local .
```

## Publishing

[The workflow](.github/workflows/publish.yaml) builds Linux amd64 and arm64 images
and publishes them to
[ghcr.io/arnavdugar/chartdb-viewer](https://github.com/arnavdugar/chartdb-viewer/pkgs/container/chartdb-viewer).
Pushes to `main` update `latest`; `v*` tags produce version tags. Pull requests
build the images without publishing them.

## License

[AGPL-3.0-only](LICENSE). Built on
[ChartDB](https://github.com/chartdb/chartdb/tree/v1.20.1).
