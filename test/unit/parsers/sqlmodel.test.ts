import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { sqlmodelParser } from '../../../src/parsers/sqlmodel';

const parse = (path: string, text: string) => sqlmodelParser.parse({ path, text });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

const HEROES = `
from typing import Optional, List
from sqlmodel import SQLModel, Field, Relationship


class HeroBase(SQLModel):
    name: str = Field(index=True)
    secret_name: str


class Team(SQLModel, table=True):
    __tablename__ = "teams"
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    heroes: List["Hero"] = Relationship(back_populates="team")


class Hero(HeroBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    age: Optional[int] = Field(default=None)
    team_id: int | None = Field(default=None, foreign_key="teams.id")
    team: Optional[Team] = Relationship(back_populates="heroes")
`;

describe('sqlmodel detect', () => {
  it('claims SQLModel files only', () => {
    expect(sqlmodelParser.detect({ path: 'models.py', text: HEROES })).toBe(true);
    expect(sqlmodelParser.detect({ path: 'm.py', text: 'from sqlalchemy import Column\nclass X(Base):\n    pass\n' })).toBe(false);
    expect(sqlmodelParser.detect({ path: 'm.py', text: 'from pydantic import BaseModel\nclass X(BaseModel):\n    id: int\n' })).toBe(false);
  });
});

describe('sqlmodel parse', () => {
  it('reads table models, their primary key and foreign_key relations', () => {
    const r = parse('models.py', HEROES);
    const team = r.entities.find((e) => e.modelName === 'Team')!;
    expect(team).toMatchObject({ name: 'teams', nameCertainty: 2 });
    expect(names(team.columns)).toEqual(['id', 'name']);
    expect(team.columns[0]).toMatchObject({ name: 'id', primaryKey: true, nullable: false, type: 'int' });
    expect(team.columns[1]).toMatchObject({ unique: true });

    const hero = r.entities.find((e) => e.modelName === 'Hero')!;
    expect(hero).toMatchObject({ name: 'hero', nameCertainty: 0 });
    expect(hero.extends).toEqual(['HeroBase']);
    // Relationship fields are not columns.
    expect(names(hero.columns)).toEqual(['id', 'age', 'team_id']);
    expect(hero.columns.find((c) => c.name === 'age')!.nullable).toBe(true);

    const fk = r.relations.find((x) => x.fromColumns[0] === 'team_id')!;
    expect(fk).toMatchObject({ from: { model: 'Hero' }, to: { name: 'teams' }, toColumns: ['id'], cardinality: 'many-to-one', optional: true });
  });

  it('emits non-table SQLModel subclasses as abstract bases', () => {
    const r = parse('models.py', HEROES);
    const base = r.entities.find((e) => e.modelName === 'HeroBase')!;
    expect(base.abstract).toBe(true);
    expect(names(base.columns)).toEqual(['name', 'secret_name']);
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.py', 'from sqlmodel import SQLModel\nclass Hero(SQLModel, table=True):\n    id: int = Field(\n')).not.toThrow();
  });
});

describe('sqlmodel end-to-end', () => {
  it('inherits base-model fields and links the relation', () => {
    const r = resolveSchema([{ file: 'models.py', kind: 'sqlmodel', result: parse('models.py', HEROES) }]);
    expect(r.entities.filter((e) => !e.external).map((e) => e.id).sort()).toEqual(['hero', 'teams']);
    const hero = r.entities.find((e) => e.id === 'hero')!;
    // HeroBase fields are copied into Hero by the resolver.
    expect(names(hero.columns)).toEqual(['name', 'secret_name', 'id', 'age', 'team_id']);
    expect(hero.columns.find((c) => c.name === 'team_id')!.references).toEqual({ entity: 'teams', column: 'id' });
    expect(r.relations).toEqual([
      expect.objectContaining({ from: 'hero', fromColumns: ['team_id'], to: 'teams', toColumns: ['id'], cardinality: 'many-to-one' }),
    ]);
  });
});
