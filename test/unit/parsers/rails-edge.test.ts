import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { railsParser } from '../../../src/parsers/rails';

const parse = (path: string, text: string) => railsParser.parse({ path, text });

// Found while scanning mastodon/mastodon: a `rescue ActiveRecord::RecordNotFound` in a controller or
// service made the whole file look like a model file, and `parseModels` emitted one table per
// `class X < Y` – inflating a 118-table schema to 198 tables (`media_controllers`, `report_services`,
// `distribution_workers`, `initial_state_serializers`, `corruption_errors`, …).
describe('rails phantom-table regressions', () => {
  it('does not treat controllers / services that merely mention ActiveRecord as model files', () => {
    const controller = {
      path: 'app/controllers/media_controller.rb',
      text: [
        'class MediaController < ApplicationController',
        '  before_action :authenticate_user!',
        '  rescue_from ActiveRecord::RecordNotFound, with: :not_found',
        'end',
      ].join('\n'),
    };
    const service = {
      path: 'app/services/report_service.rb',
      text: ['class ReportService < BaseService', '  def call', '    raise ActiveRecord::RecordNotFound', '  end', 'end'].join('\n'),
    };
    expect(railsParser.detect(controller)).toBe(false);
    expect(railsParser.detect(service)).toBe(false);
    // Even if parsed anyway (e.g. multi-parser candidacy), no entities must be produced.
    expect(parse(controller.path, controller.text).entities).toEqual([]);
    expect(parse(service.path, service.text).entities).toEqual([]);
  });

  it('ignores non-ActiveRecord classes that live in app/models (serializers, errors, value objects)', () => {
    const text = [
      'class PreviewCard < ApplicationRecord',
      '  has_many :statuses',
      'end',
      '',
      'class Author < ActiveModelSerializers::Model',
      '  attributes :url, :username',
      'end',
      '',
      'class CorruptionError < StandardError; end',
    ].join('\n');
    const r = parse('app/models/preview_card.rb', text);
    expect(r.entities.map((e) => e.modelName)).toEqual(['PreviewCard']);
  });

  it('marks a Rails 7 `primary_abstract_class` ApplicationRecord as abstract (no phantom table)', () => {
    const text = 'class ApplicationRecord < ActiveRecord::Base\n  primary_abstract_class\nend';
    const r = parse('app/models/application_record.rb', text);
    const app = r.entities.find((e) => e.modelName === 'ApplicationRecord')!;
    expect(app.abstract).toBe(true);
    // Resolver must not surface an `application_records` table.
    const resolved = resolveSchema([{ file: 'app/models/application_record.rb', kind: 'rails', result: r }]);
    expect(resolved.entities.some((e) => e.id === 'application_records')).toBe(false);
  });

  it('still reads real models and keeps same-file STI subclasses', () => {
    const text = [
      'class User < ApplicationRecord',
      '  has_many :posts',
      'end',
      '',
      'class Admin < User',
      '  belongs_to :team, optional: true',
      'end',
    ].join('\n');
    const r = parse('app/models/user.rb', text);
    expect(r.entities.map((e) => e.modelName)).toEqual(['User', 'Admin']);
    expect(r.entities.find((e) => e.modelName === 'Admin')).toMatchObject({ sharedTable: true, extends: ['User'] });
  });

  it('keeps a cross-file STI child in app/models that declares associations', () => {
    // `Voter`'s parent is in another file, so model-ness is inferred from the ActiveRecord DSL it uses.
    const text = 'class LocalVoter < Voter\n  belongs_to :account\nend';
    const r = parse('app/models/local_voter.rb', text);
    expect(r.entities.map((e) => e.modelName)).toEqual(['LocalVoter']);
  });
});
