"""Exercise the shipped CLI through its HTTP boundary without a workspace or grant."""
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import urllib.error

import pytest


@pytest.fixture
def cli(monkeypatch):
    loader = importlib.machinery.SourceFileLoader('connector_cli_test', str(Path(__file__).parent / 'bin' / 'delegent-connect'))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    monkeypatch.setenv('OPENAI_API_KEY', 'local-test-key')
    monkeypatch.setenv('OPENAI_BASE_URL', 'http://127.0.0.1:8642/v1')
    return module


NATIVE = {'provider': 'freeagent', 'backend': 'native', 'status': 'connected'}
GMAIL = {'provider': 'gmail', 'backend': 'composio', 'status': 'connected', 'toolkit': 'gmail'}


def http(monkeypatch, cli, replies):
    calls = []

    def open_request(request, timeout):
        assert request.full_url.startswith('http://127.0.0.1:8642/v1/delegent/connections')
        assert timeout == 30
        calls.append(request)
        assert replies, 'unexpected additional request'
        status, payload = replies.pop(0)
        content = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, 'test', {}, io.BytesIO(content))
        response = io.BytesIO(content)
        response.status = status
        return response

    monkeypatch.setattr(cli.urllib.request, 'urlopen', open_request)
    return calls


def failure(cli, capsys, args, code=1):
    with pytest.raises(SystemExit) as raised:
        cli.main(args)
    assert raised.value.code == code
    return capsys.readouterr()


@pytest.mark.parametrize('flag,known', [('nativeUnavailable', GMAIL), ('composioUnavailable', NATIVE)])
def test_list_preserves_partial_inventory_and_returns_failure(cli, monkeypatch, capsys, flag, known):
    http(monkeypatch, cli, [(200, {'connections': [known], flag: True})])
    output = failure(cli, capsys, ['list'])
    assert json.loads(output.out) == {'connections': [known], flag: True}
    assert 'Do not ask the user to reconnect' in output.err
    assert 'continue independent work' in output.err


@pytest.mark.parametrize('body', [{}, [], {'connections': [None]}, {'connections': {}}, {'connections': [{'provider': 'freeagent'}]}, b'{'])
def test_malformed_list_is_not_reported_empty(cli, monkeypatch, capsys, body):
    http(monkeypatch, cli, [(200, body)])
    output = failure(cli, capsys, ['list'])
    assert not output.out


def test_authoritative_empty_list_is_success(cli, monkeypatch, capsys):
    http(monkeypatch, cli, [(200, {'connections': []})])
    assert cli.main(['list']) == 0
    assert json.loads(capsys.readouterr().out) == {'connections': []}


@pytest.mark.parametrize('inventory', [(503, {'error': 'connections_unreadable'}), (200, {'connections': [], 'nativeUnavailable': True}), (200, {'connections': [], 'composioUnavailable': True})])
def test_run_does_not_turn_failed_inventory_into_missing_connection(cli, monkeypatch, capsys, inventory):
    calls = http(monkeypatch, cli, [inventory])
    output = failure(cli, capsys, ['run', '--service', 'freeagent', '--', 'test-command'])
    assert len(calls) == 1
    assert 'could not be checked' in output.err


@pytest.mark.parametrize('status,error,exit_code', [(503, 'connections_unreadable', 1), (404, 'unknown_provider', 1), (404, 'not_connected', 2), (409, 'needs_reauth', 2), (503, 'refresh_busy', 1), (409, 'refresh_recovery_required', 2), (503, 'refresh_persistence_failed', 1)])
def test_run_only_requests_reconnection_for_confirmed_missing_or_lapsed_grant(cli, monkeypatch, capsys, status, error, exit_code):
    http(monkeypatch, cli, [(200, {'connections': [NATIVE]}), (status, {'error': error})])
    output = failure(cli, capsys, ['run', '--service', 'freeagent', '--', 'test-command'], exit_code)
    assert ('Connections screen' in output.err) == (exit_code == 2)


def test_known_native_service_can_run_during_composio_outage_without_printing_token(cli, monkeypatch, capsys):
    calls = http(monkeypatch, cli, [(200, {'connections': [NATIVE], 'composioUnavailable': True}), (200, {'accessToken': 'secret-access-test'})])
    children = []

    def run(command, env):
        children.append((command, env['DELEGENT_ACCESS_TOKEN']))
        return type('Result', (), {'returncode': 0})()

    monkeypatch.setattr(cli.subprocess, 'run', run)
    assert cli.main(['run', '--service', 'freeagent', '--', 'test-command']) == 0
    assert children == [(['test-command'], 'secret-access-test')]
    assert len(calls) == 2
    output = capsys.readouterr()
    assert 'secret-access-test' not in output.out + output.err


def test_known_composio_service_directs_to_exec_during_native_outage(cli, monkeypatch, capsys):
    calls = http(monkeypatch, cli, [(200, {'connections': [GMAIL], 'nativeUnavailable': True})])
    output = failure(cli, capsys, ['run', '--service', 'gmail', '--', 'test-command'])
    assert 'Use `exec` instead' in output.err
    assert len(calls) == 1


@pytest.mark.parametrize('body', [{'error': 'rate_limited', 'retryAfterSeconds': 17}, {'error': 'rate_limited'}, {}, {'retryAfterSeconds': True}, {'retryAfterSeconds': -1}])
def test_generic_429_is_transient_and_does_not_blindly_retry_writes(cli, monkeypatch, capsys, body):
    calls = http(monkeypatch, cli, [(429, body)])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_SEND_EMAIL'])
    assert 'temporarily rate limited' in output.err
    assert 'check whether it completed before retrying' in output.err
    assert 'run too many' not in output.err
    assert 'retry at most once' in output.err
    assert ('at least 17 seconds' in output.err) == (body.get('retryAfterSeconds') == 17)
    assert len(calls) == 1


def test_explicit_quota_exhaustion_stops_retrying(cli, monkeypatch, capsys):
    http(monkeypatch, cli, [(429, {'error': 'quota_exceeded'})])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_FETCH_EMAILS'])
    assert 'this month' in output.err
    assert 'stop retrying' in output.err


@pytest.mark.parametrize('status,body', [(503, {'error': 'connections_unreadable'}), (503, {'error': 'not_configured'}), (409, {'error': 'other_conflict'}), (502, [])])
def test_generic_service_error_does_not_request_reconnection(cli, monkeypatch, capsys, status, body):
    http(monkeypatch, cli, [(status, body)])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_FETCH_EMAILS'])
    assert 'Ask the user to connect' not in output.err


def test_confirmed_broker_missing_grant_still_requests_connection(cli, monkeypatch, capsys):
    http(monkeypatch, cli, [(409, {'error': 'not_connected', 'provider': 'gmail'})])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_FETCH_EMAILS'], 2)
    assert 'Connections screen' in output.err


def test_provider_failure_in_http_200_remains_a_failed_action(cli, monkeypatch, capsys):
    http(monkeypatch, cli, [(200, {'result': {'successful': False, 'error': 'invalid argument'}})])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_FETCH_EMAILS'])
    assert json.loads(output.out)['successful'] is False
    assert 'invalid argument' in output.err


def test_successful_action_still_returns_result(cli, monkeypatch, capsys):
    http(monkeypatch, cli, [(200, {'result': {'successful': True, 'data': []}})])
    assert cli.main(['exec', '--tool', 'GMAIL_FETCH_EMAILS']) == 0
    assert json.loads(capsys.readouterr().out) == {'successful': True, 'data': []}


@pytest.mark.parametrize('body', [{}, [], {'result': None}, b'{'])
def test_malformed_action_result_cannot_be_reported_successful(cli, monkeypatch, capsys, body):
    http(monkeypatch, cli, [(200, body)])
    output = failure(cli, capsys, ['exec', '--tool', 'GMAIL_SEND_EMAIL'])
    assert not output.out
