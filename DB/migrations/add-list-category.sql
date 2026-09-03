-- Custom lists can belong to a category (movie | series | anime | game) or stay
-- mixed (NULL). Used to browse/filter lists by category on your own and others' profiles.

ALTER TABLE custom_lists
  ADD COLUMN IF NOT EXISTS category varchar(16);
