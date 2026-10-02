CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE
);

CREATE TABLE posts (
  id serial PRIMARY KEY,
  title text NOT NULL,
  author_id int NOT NULL REFERENCES users(id)
);
