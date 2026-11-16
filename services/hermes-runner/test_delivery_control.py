import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture
def delivery(monkeypatch, tmp_path):
    monkeypatch.setenv('SIDEKICK_USER_ID', 'owner')
    monkeypatch.setenv('SIDEKICK_RUNNER_SHARED_SECRET', 'delivery-test-secret')
    monkeypatch.setenv('DELEGENT_PLATFORM_SECRET', 'local-platform-secret')
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(server, '_DELEGENT_RUNS', {})
    monkeypatch.setattr(server, '_DELEGENT_STREAMS', {})
    monkeypatch.setattr(server, '_ensure_delegent_skills_present', lambda path: None)
    requests = []

    def gateway(request):
        requests.append(request)
        return httpx.Response(200, json={'ok': True, 'accepted': True})

    upstream = httpx.AsyncClient(transport=httpx.MockTransport(gateway))
    monkeypatch.setattr(server, '_hermes_client', lambda: upstream)
    headers = server.build_sidekick_runner_headers(user_id='owner', shared_secret='delivery-test-secret', now=int(time.time()))
    return TestClient(server.app), headers, requests


def test_dispatch_claim_and_reply_survive_wrapper_restart(delivery, monkeypatch):
    client, headers, requests = delivery
    payload = {'text': 'only once', 'run_id': 'durable-run'}
    assert client.post('/v1/delegent/message', json=payload, headers=headers).status_code == 200
    server._delegent_run_record_update('durable-run', {'kind': 'send', 'text': 'durable answer'})
    server._delegent_run_record_update('durable-run', {'kind': 'done', 'outcome': 'success'})
    monkeypatch.setattr(server, '_DELEGENT_RUNS', {})
    monkeypatch.setattr(server, '_DELEGENT_STREAMS', {})
    monkeypatch.setattr(server, '_DELEGENT_PROCESS_ID', 'new-process')
    assert client.post('/v1/delegent/message', json=payload, headers=headers).json()['replayed'] is True
    assert len(requests) == 1
    record = client.get('/v1/delegent/runs/durable-run', headers=headers).json()
    assert record['done'] is True and record['text'] == 'durable answer'
    stream = client.get('/v1/delegent/runs/durable-run/events', headers=headers)
    assert stream.status_code == 200 and 'durable answer' in stream.text and '"done"' in stream.text
    assert client.post('/v1/delegent/runs/durable-run/ack', headers=headers).status_code == 200


def test_interrupted_run_is_not_executed_again_after_restart(delivery, monkeypatch):
    client, headers, requests = delivery
    payload = {'text': 'started work', 'run_id': 'interrupted-run'}
    client.post('/v1/delegent/message', json=payload, headers=headers)
    monkeypatch.setattr(server, '_DELEGENT_RUNS', {})
    monkeypatch.setattr(server, '_DELEGENT_PROCESS_ID', 'new-process')
    record = client.get('/v1/delegent/runs/interrupted-run', headers=headers).json()
    assert record['done'] is True and record['outcome'] == 'failure'
    client.post('/v1/delegent/message', json=payload, headers=headers)
    assert len(requests) == 1


def test_controls_require_hmac_confirmation_and_authenticated_owner(delivery):
    client, headers, requests = delivery
    assert client.post('/v1/delegent/control', json={'action': 'reset', 'confirmed': True}).status_code == 401
    assert client.post('/v1/delegent/control', json={'action': 'reset'}, headers=headers).status_code == 409
    assert not requests
    response = client.post('/v1/delegent/control', json={'action': 'reset', 'confirmed': True, 'user_id': 'victim'}, headers=headers)
    assert response.status_code == 200
    body = json.loads(requests[0].content)
    assert body == {'action': 'reset', 'confirmed': True, 'user_id': 'owner', 'run_id': None}
    assert requests[0].headers['x-delegent-platform-secret'] == 'local-platform-secret'
