CREATE TABLE issues (
  id            serial PRIMARY KEY,
  project_key   text NOT NULL,
  status        text NOT NULL,
  priority      text,
  assignee_id   text,
  summary       text NOT NULL,
  created_at    timestamptz NOT NULL,
  points        numeric,
  resolved      boolean NOT NULL DEFAULT false,
  custom_fields jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX issues_custom_fields_gin ON issues USING gin (custom_fields);

CREATE TABLE issue_changelogs (
  id         serial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES issues(id),
  field      text NOT NULL,
  from_value text,
  to_value   text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX issue_changelogs_lookup ON issue_changelogs (issue_id, field);

INSERT INTO issues (id, project_key, status, priority, assignee_id, summary, created_at, points, resolved, custom_fields) VALUES
 (1,'PROJ','Open','High','usr_9921','Login 100% broken','2026-11-24T08:00:00Z',3,false,'{"story_points":"5","team":"core"}'),
 (2,'PROJ','Done','Low',NULL,'Docs typo','2026-11-10T08:00:00Z',1,true,'{"story_points":"1"}'),
 (3,'PROJ','In Progress','High','usr_1','Login_page slow','2026-11-20T08:00:00Z',NULL,false,'{"team":"web"}'),
 (4,'OTHER','Open',NULL,'usr_9921','Unrelated','2026-11-25T01:00:00Z',8,false,'{}'),
 (5,'PROJ','Open','Medium','','Empty-string assignee','2026-11-01T00:00:00Z',2,false,'{"team":""}');
SELECT setval('issues_id_seq', 5);

INSERT INTO issue_changelogs (issue_id, field, from_value, to_value) VALUES
 (1,'status',NULL,'Open'),
 (2,'status',NULL,'Open'),(2,'status','Open','In Progress'),(2,'status','In Progress','Done'),
 (3,'status',NULL,'Open'),(3,'status','Open','In Progress'),
 (4,'status',NULL,'Open'),(5,'status',NULL,'Open');
