CREATE TABLE items (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE
);
