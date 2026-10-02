import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { tortoiseParser } from '../../../src/parsers/tortoise';

const parse = (path: string, text: string) => tortoiseParser.parse({ path, text });
const names = (cols: { name: string }[]) => cols.map((c) => c.name);

const EVENTS = `
from tortoise.models import Model
from tortoise import fields


class Tournament(Model):
    id = fields.IntField(pk=True)
    name = fields.CharField(max_length=255, unique=True)

    class Meta:
        table = "tournaments"


class Team(Model):
    name = fields.CharField(max_length=50, source_field="team_name")


class Event(Model):
    name = fields.CharField(max_length=255, null=True)
    tournament = fields.ForeignKeyField("models.Tournament", related_name="events", on_delete=fields.CASCADE)
    participants = fields.ManyToManyField("models.Team", related_name="events", through="event_team")
`;

describe('tortoise detect', () => {
  it('claims tortoise files only', () => {
    expect(tortoiseParser.detect({ path: 'models.py', text: EVENTS })).toBe(true);
    expect(tortoiseParser.detect({ path: 'm.py', text: 'from django.db import models\nclass X(models.Model):\n    n = models.CharField(max_length=1)\n' })).toBe(false);
    expect(tortoiseParser.detect({ path: 'm.py', text: 'from sqlalchemy import Column\nclass X(Base):\n    pass\n' })).toBe(false);
  });
});

describe('tortoise parse', () => {
  it('reads fields, Meta.table and explicit pk', () => {
    const r = parse('models.py', EVENTS);
    const t = r.entities.find((e) => e.modelName === 'Tournament')!;
    expect(t).toMatchObject({ name: 'tournaments', nameCertainty: 2 });
    expect(names(t.columns)).toEqual(['id', 'name']);
    expect(t.columns[0]).toMatchObject({ name: 'id', primaryKey: true, nullable: false });
    expect(t.columns.find((c) => c.name === 'name')).toMatchObject({ unique: true, type: 'CharField' });
  });

  it('adds the implicit id primary key and respects source_field', () => {
    const r = parse('models.py', EVENTS);
    const team = r.entities.find((e) => e.modelName === 'Team')!;
    expect(team).toMatchObject({ name: 'team', nameCertainty: 0 });
    expect(names(team.columns)).toEqual(['id', 'team_name']);
    expect(team.columns[0]).toMatchObject({ primaryKey: true, type: 'IntField', generated: true });
  });

  it('reads foreign keys (<name>_id) and many-to-many with through', () => {
    const r = parse('models.py', EVENTS);
    const event = r.entities.find((e) => e.modelName === 'Event')!;
    expect(names(event.columns)).toEqual(['id', 'name', 'tournament_id']);
    const fk = r.relations.find((x) => x.fromColumns[0] === 'tournament_id')!;
    expect(fk).toMatchObject({ to: { model: 'Tournament' }, cardinality: 'many-to-one', onDelete: 'CASCADE' });
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect(m2m).toMatchObject({ from: { model: 'Event' }, to: { model: 'Team' }, through: { name: 'event_team' } });
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('m.py', 'from tortoise.models import Model\nclass A(Model):\n    x = fields.CharField(\n')).not.toThrow();
  });
});

describe('tortoise end-to-end', () => {
  it('links the events schema', () => {
    const r = resolveSchema([{ file: 'models.py', kind: 'tortoise', result: parse('models.py', EVENTS) }]);
    expect(r.entities.filter((e) => !e.external).map((e) => e.id).sort()).toEqual(['event', 'team', 'tournaments']);
    const event = r.entities.find((e) => e.id === 'event')!;
    expect(event.columns.find((c) => c.name === 'tournament_id')!.references).toEqual({ entity: 'tournaments', column: 'id' });
    expect(r.relations.find((x) => x.cardinality === 'many-to-many')).toMatchObject({ from: 'event', to: 'team', throughName: 'event_team' });
  });
});
