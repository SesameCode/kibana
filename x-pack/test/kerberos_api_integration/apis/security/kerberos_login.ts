/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import expect from '@kbn/expect';
import request, { Cookie } from 'request';
import { delay } from 'bluebird';
import { KibanaFunctionalTestDefaultProviders } from '../../../types/providers';

// eslint-disable-next-line import/no-default-export
export default function({ getService }: KibanaFunctionalTestDefaultProviders) {
  const spnegoToken =
    'YIIChwYGKwYBBQUCoIICezCCAnegDTALBgkqhkiG9xIBAgKiggJkBIICYGCCAlwGCSqGSIb3EgECAgEAboICSzCCAkegAwIBBaEDAgEOogcDBQAAAAAAo4IBW2GCAVcwggFToAMCAQWhERsPVEVTVC5FTEFTVElDLkNPohwwGqADAgEDoRMwERsESFRUUBsJbG9jYWxob3N0o4IBGTCCARWgAwIBEqEDAgECooIBBwSCAQNBN2a1Rso+KEJsDwICYLCt7ACLzdlbhEZF5YNsehO109b/WiZR1VTK6kCQyDdBdQFefyvV8EiC35mz7XnTb239nWz6xBGbdmtjSfF0XzpXKbL/zGzLEKkEXQuqFLPUN6qEJXsh0OoNdj9OWwmTr93FVyugs1hO/E5wjlAe2SDYpBN6uZICXu6dFg9nLQKkb/XgbgKM7ZZvgA/UElWDgHav4nPO1VWppCCLKHqXTRnvpr/AsxeON4qeJLaukxBigfIaJlLFMNQal5H7MyXa0j3Y1sckbURnWoBt6r4XE7c8F8cz0rYoGwoCO+Cs5tNutKY6XcsAFbLh59hjgIkhVBhhyTeypIHSMIHPoAMCARKigccEgcSsXqIRAcHfZivrbHfsnvbFgmzmnrKVPFNtJ9Hl23KunCsNW49nP4VF2dEf9n12prDaIguJDV5LPHpTew9rmCj1GCahKJ9bJbRKIgImLFd+nelm3E2zxRqAhrgM1469oDg0ksE3+5lJBuJlVEECMp0F/gxvEiL7DhasICqw+FOJ/jD9QUYvg+E6BIxWgZyPszaxerzBBszAhIF1rxCHRRL1KLjskNeJlBhH77DkAO6AEmsYGdsgEq7b7uCov9PKPiiPAuFF';
  const supertest = getService('supertestWithoutAuth');
  const config = getService('config');

  function checkCookieIsSet(cookie: Cookie) {
    expect(cookie.value).to.not.be.empty();

    expect(cookie.key).to.be('sid');
    expect(cookie.path).to.be('/');
    expect(cookie.httpOnly).to.be(true);
    expect(cookie.maxAge).to.be(null);
  }

  function checkCookieIsCleared(cookie: Cookie) {
    expect(cookie.value).to.be.empty();

    expect(cookie.key).to.be('sid');
    expect(cookie.path).to.be('/');
    expect(cookie.httpOnly).to.be(true);
    expect(cookie.maxAge).to.be(0);
  }

  describe('Kerberos authentication', () => {
    before(async () => {
      // HACK: remove as soon as we have a solution for https://github.com/elastic/elasticsearch/issues/41943.
      await getService('esSupertest')
        .post('/_security/role/krb5-user')
        .send({ cluster: ['cluster:admin/xpack/security/token/create'] })
        .expect(200);

      await getService('esSupertest')
        .post('/_security/role_mapping/krb5')
        .send({
          roles: ['krb5-user'],
          enabled: true,
          rules: { field: { 'realm.name': 'kerb1' } },
        })
        .expect(200);
    });

    it('should reject API requests if client is not authenticated', async () => {
      await supertest
        .get('/api/security/v1/me')
        .set('kbn-xsrf', 'xxx')
        .expect(401);
    });

    it('does not prevent basic login', async () => {
      const [username, password] = config.get('servers.elasticsearch.auth').split(':');
      const response = await supertest
        .post('/api/security/v1/login')
        .set('kbn-xsrf', 'xxx')
        .send({ username, password })
        .expect(204);

      const cookies = response.headers['set-cookie'];
      expect(cookies).to.have.length(1);

      const cookie = request.cookie(cookies[0])!;
      checkCookieIsSet(cookie);

      const { body: user } = await supertest
        .get('/api/security/v1/me')
        .set('kbn-xsrf', 'xxx')
        .set('Cookie', cookie.cookieString())
        .expect(200);

      expect(user.username).to.eql(username);
      expect(user.authentication_realm).to.eql({ name: 'reserved', type: 'reserved' });
    });

    describe('initiating SPNEGO', () => {
      it('non-AJAX requests should properly initiate SPNEGO', async () => {
        const spnegoResponse = await supertest.get('/abc/xyz/spnego?one=two three').expect(401);

        expect(spnegoResponse.headers['set-cookie']).to.be(undefined);
        expect(spnegoResponse.headers['www-authenticate']).to.be('Negotiate');
      });

      it('AJAX requests should properly initiate SPNEGO', async () => {
        const ajaxResponse = await supertest
          .get('/abc/xyz/spnego?one=two three')
          .set('kbn-xsrf', 'xxx')
          .expect(401);

        expect(ajaxResponse.headers['set-cookie']).to.be(undefined);
        expect(ajaxResponse.headers['www-authenticate']).to.be('Negotiate');
      });
    });

    describe('finishing SPNEGO', () => {
      it('should properly set cookie and authenticate user', async () => {
        const response = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${spnegoToken}`)
          .expect(200);

        const cookies = response.headers['set-cookie'];
        expect(cookies).to.have.length(1);

        const sessionCookie = request.cookie(cookies[0])!;
        checkCookieIsSet(sessionCookie);

        await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(200, {
            username: 'tester@TEST.ELASTIC.CO',
            roles: ['krb5-user'],
            full_name: null,
            email: null,
            metadata: {
              kerberos_user_principal_name: 'tester@TEST.ELASTIC.CO',
              kerberos_realm: 'TEST.ELASTIC.CO',
            },
            enabled: true,
            authentication_realm: { name: 'kerb1', type: 'kerberos' },
            lookup_realm: { name: 'kerb1', type: 'kerberos' },
          });
      });

      it('should fail if SPNEGO token is rejected', async () => {
        const spnegoResponse = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${Buffer.from('Hello').toString('base64')}`)
          .expect(401);
        expect(spnegoResponse.headers['set-cookie']).to.be(undefined);
        expect(spnegoResponse.headers['www-authenticate']).to.be(undefined);
      });
    });

    describe('API access with active session', () => {
      let sessionCookie: Cookie;

      beforeEach(async () => {
        const response = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${spnegoToken}`)
          .expect(200);

        const cookies = response.headers['set-cookie'];
        expect(cookies).to.have.length(1);

        sessionCookie = request.cookie(cookies[0])!;
        checkCookieIsSet(sessionCookie);
      });

      it('should extend cookie on every successful non-system API call', async () => {
        const apiResponseOne = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(200);

        expect(apiResponseOne.headers['set-cookie']).to.not.be(undefined);
        const sessionCookieOne = request.cookie(apiResponseOne.headers['set-cookie'][0])!;

        checkCookieIsSet(sessionCookieOne);
        expect(sessionCookieOne.value).to.not.equal(sessionCookie.value);

        const apiResponseTwo = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(200);

        expect(apiResponseTwo.headers['set-cookie']).to.not.be(undefined);
        const sessionCookieTwo = request.cookie(apiResponseTwo.headers['set-cookie'][0])!;

        checkCookieIsSet(sessionCookieTwo);
        expect(sessionCookieTwo.value).to.not.equal(sessionCookieOne.value);
      });

      it('should not extend cookie for system API calls', async () => {
        const systemAPIResponse = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('kbn-system-api', 'true')
          .set('Cookie', sessionCookie.cookieString())
          .expect(200);

        expect(systemAPIResponse.headers['set-cookie']).to.be(undefined);
      });

      it('should fail and preserve session cookie if unsupported authentication schema is used', async () => {
        const apiResponse = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Authorization', 'Bearer AbCdEf')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        expect(apiResponse.headers['set-cookie']).to.be(undefined);
      });
    });

    describe('logging out', () => {
      it('should redirect to `logged_out` page after successful logout', async () => {
        // First authenticate user to retrieve session cookie.
        const response = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${spnegoToken}`)
          .expect(200);

        let cookies = response.headers['set-cookie'];
        expect(cookies).to.have.length(1);

        const sessionCookie = request.cookie(cookies[0])!;
        checkCookieIsSet(sessionCookie);

        // And then log user out.
        const logoutResponse = await supertest
          .get('/api/security/v1/logout')
          .set('Cookie', sessionCookie.cookieString())
          .expect(302);

        cookies = logoutResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(logoutResponse.headers.location).to.be('/logged_out');

        // Token that was stored in the previous cookie should be invalidated as well and old
        // session cookie should not allow API access.
        const apiResponse = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        // If Kibana detects cookie with invalid token it tries to clear it.
        cookies = apiResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(apiResponse.headers['www-authenticate']).to.be('Negotiate');
      });

      it('should redirect to home page if session cookie is not provided', async () => {
        const logoutResponse = await supertest.get('/api/security/v1/logout').expect(302);

        expect(logoutResponse.headers['set-cookie']).to.be(undefined);
        expect(logoutResponse.headers.location).to.be('/');
      });
    });

    describe('API access with expired access token.', () => {
      let sessionCookie: Cookie;

      beforeEach(async () => {
        const response = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${spnegoToken}`)
          .expect(200);

        const cookies = response.headers['set-cookie'];
        expect(cookies).to.have.length(1);

        sessionCookie = request.cookie(cookies[0])!;
        checkCookieIsSet(sessionCookie);
      });

      it('AJAX call should initiate SPNEGO and clear existing cookie', async function() {
        this.timeout(40000);

        // Access token expiration is set to 15s for API integration tests.
        // Let's wait for 20s to make sure token expires.
        await delay(20000);

        const apiResponse = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        const cookies = apiResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(apiResponse.headers['www-authenticate']).to.be('Negotiate');
      });

      it('non-AJAX call should initiate SPNEGO and clear existing cookie', async function() {
        this.timeout(40000);

        // Access token expiration is set to 15s for API integration tests.
        // Let's wait for 20s to make sure token expires.
        await delay(20000);

        const nonAjaxResponse = await supertest
          .get('/')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        const cookies = nonAjaxResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(nonAjaxResponse.headers['www-authenticate']).to.be('Negotiate');
      });
    });

    describe('API access with missing access token document.', () => {
      let sessionCookie: Cookie;

      beforeEach(async () => {
        const response = await supertest
          .get('/api/security/v1/me')
          .set('Authorization', `Negotiate ${spnegoToken}`)
          .expect(200);

        const cookies = response.headers['set-cookie'];
        expect(cookies).to.have.length(1);

        sessionCookie = request.cookie(cookies[0])!;
        checkCookieIsSet(sessionCookie);

        // Let's delete tokens from `.security-tokens` index directly to simulate the case when
        // Elasticsearch automatically removes access token document from the index after some
        // period of time.
        const esResponse = await getService('es').deleteByQuery({
          index: '.security-tokens',
          q: 'doc_type:token',
          refresh: true,
        });
        expect(esResponse)
          .to.have.property('deleted')
          .greaterThan(0);
      });

      it('AJAX call should initiate SPNEGO and clear existing cookie', async function() {
        const apiResponse = await supertest
          .get('/api/security/v1/me')
          .set('kbn-xsrf', 'xxx')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        const cookies = apiResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(apiResponse.headers['www-authenticate']).to.be('Negotiate');
      });

      it('non-AJAX call should initiate SPNEGO and clear existing cookie', async function() {
        const nonAjaxResponse = await supertest
          .get('/')
          .set('Cookie', sessionCookie.cookieString())
          .expect(401);

        const cookies = nonAjaxResponse.headers['set-cookie'];
        expect(cookies).to.have.length(1);
        checkCookieIsCleared(request.cookie(cookies[0])!);

        expect(nonAjaxResponse.headers['www-authenticate']).to.be('Negotiate');
      });
    });
  });
}
