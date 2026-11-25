CREATE TABLE issues (
  id            int AUTO_INCREMENT PRIMARY KEY,
  project_key   text NOT NULL,
  status        text NOT NULL,
  priority      text,
  assignee_id   text,
  summary       text NOT NULL,
  created_at    datetime NOT NULL,
  points        decimal(10,2),
  resolved      tinyint(1) NOT NULL DEFAULT 0,
  custom_fields json NOT NULL
);

CREATE TABLE issue_changelogs (
  id         int AUTO_INCREMENT PRIMARY KEY,
  issue_id   int NOT NULL REFERENCES issues(id),
  field      text NOT NULL,
  from_value text,
  to_value   text,
  changed_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO issues (id, project_key, status, priority, assignee_id, summary, created_at, points, resolved, custom_fields) VALUES
 (1,'PROJ','Open','High','usr_9921','Login 100% broken','2026-11-24 08:00:00',3,0,'{"story_points":"5","team":"core"}'),
 (2,'PROJ','Done','Low',NULL,'Docs typo','2026-11-10 08:00:00',1,1,'{"story_points":"1"}'),
 (3,'PROJ','In Progress','High','usr_1','Login_page slow','2026-11-20 08:00:00',NULL,0,'{"team":"web"}'),
 (4,'OTHER','Open',NULL,'usr_9921','Unrelated','2026-11-25 01:00:00',8,0,'{}'),
 (5,'PROJ','Open','Medium','','Empty-string assignee','2026-11-01 00:00:00',2,0,'{"team":""}');

INSERT INTO issue_changelogs (issue_id, field, from_value, to_value) VALUES
 (1,'status',NULL,'Open'),
 (2,'status',NULL,'Open'),(2,'status','Open','In Progress'),(2,'status','In Progress','Done'),
 (3,'status',NULL,'Open'),(3,'status','Open','In Progress'),
 (4,'status',NULL,'Open'),(5,'status',NULL,'Open');
