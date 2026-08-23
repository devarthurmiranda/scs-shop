-- One Postgres container, three databases, three roles.
-- Cross-SCS SQL is impossible: Postgres cannot query across databases,
-- and no role has rights on any database but its own.

CREATE ROLE catalog  LOGIN PASSWORD 'catalog';
CREATE ROLE checkout LOGIN PASSWORD 'checkout';
CREATE ROLE orders   LOGIN PASSWORD 'orders';

CREATE DATABASE catalog_db  OWNER catalog;
CREATE DATABASE checkout_db OWNER checkout;
CREATE DATABASE orders_db   OWNER orders;

REVOKE CONNECT ON DATABASE catalog_db  FROM PUBLIC;
REVOKE CONNECT ON DATABASE checkout_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE orders_db   FROM PUBLIC;

GRANT CONNECT ON DATABASE catalog_db  TO catalog;
GRANT CONNECT ON DATABASE checkout_db TO checkout;
GRANT CONNECT ON DATABASE orders_db   TO orders;
