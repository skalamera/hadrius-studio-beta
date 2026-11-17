// The app's admin/employee view is kept per browser profile, so every take must start in its lesson's view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewForRoute, roleViewWrites, viewForLesson } from '../tools/ai-record.mjs';

test('employee pages start in the employee view, every other page in the admin view', () => {
  assert.equal(viewForRoute('/employee/dashboard'), 'EMPLOYEE');
  assert.equal(viewForRoute('/employee/accounts?tab=holdings'), 'EMPLOYEE');
  assert.equal(viewForRoute('/employee'), 'EMPLOYEE');
  assert.equal(viewForRoute('/employees/trade-monitoring/configuration'), 'ADMIN', '/employees is the admin trade-monitoring area');
  assert.equal(viewForRoute('/people-oversight/disclosures'), 'ADMIN');
  assert.equal(viewForRoute('/testing-program/policies'), 'ADMIN');
  assert.equal(viewForRoute(''), 'ADMIN');
  assert.equal(viewForRoute(undefined), 'ADMIN');
});

test('a stored view other than the lesson\'s is rewritten in the encoding it was found in', () => {
  const entries = [
    ['8c1f-uuid_role', JSON.stringify('EMPLOYEE')],
    ['other-uuid_role', 'EMPLOYEE'],
    ['sidebar_minimized', 'false'],
  ];
  assert.deepEqual(roleViewWrites(entries, 'ADMIN'), [['8c1f-uuid_role', '"ADMIN"'], ['other-uuid_role', 'ADMIN']]);
  assert.deepEqual(roleViewWrites([['u_role', '"ADMIN"']], 'EMPLOYEE'), [['u_role', '"EMPLOYEE"']]);
});

test('a view that already matches, and keys that are not the app view, are left alone', () => {
  assert.deepEqual(roleViewWrites([['u_role', '"ADMIN"']], 'ADMIN'), []);
  assert.deepEqual(roleViewWrites([['user_role_cache', '"EMPLOYEE"'], ['x_role', '"OWNER"'], ['y_role', '{"a":1}'], ['z_role', 'not json']], 'ADMIN'), []);
  assert.deepEqual(roleViewWrites(undefined, 'ADMIN'), []);
});

const at = (route) => ({ action: 'click', url: `https://app.hadrius.com${route}?company_id=1150`, route });

test('a saved lesson is re-recorded in the view most of its pages were in', () => {
  // Started on an admin page the employee view redirects from, then spent its time on employee pages.
  const holding = [at('/people-oversight/accounts'), at('/employee/accounts'), at('/employee/accounts/9/holdings'), at('/employee/statements')];
  assert.deepEqual(viewForLesson(holding, '/people-oversight/accounts'), { view: 'EMPLOYEE', startRoute: '/employee/accounts' });
  assert.deepEqual(viewForLesson([at('/employee/disclosures'), at('/employee/disclosures')], '/employee/disclosures'), { view: 'EMPLOYEE', startRoute: '/employee/disclosures' });
  assert.deepEqual(viewForLesson([at('/testing-program/policies'), at('/testing-program/policies/3')], '/testing-program/policies'), { view: 'ADMIN', startRoute: '/testing-program/policies' });
  // Recorded from the employee dashboard, but the work was on admin pages.
  assert.deepEqual(viewForLesson([at('/employee/dashboard'), at('/employees/trade-monitoring/configuration'), at('/employees/trade-monitoring/rules/new')], '/employee/dashboard'), { view: 'ADMIN', startRoute: '/employees/trade-monitoring/configuration' });
  assert.deepEqual(viewForLesson([], '/overview'), { view: 'ADMIN', startRoute: '/overview' });
});
