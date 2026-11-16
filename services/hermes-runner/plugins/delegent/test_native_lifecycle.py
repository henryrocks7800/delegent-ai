"""Exercise delivery/control against the pinned native gateway, without model calls.

Run in the golden image or an isolated installation of the pinned Hermes tree.
Only the model execution boundary is replaced. HTTP admission, native task
ownership, stop, slash confirmation and durable session rotation are real.
"""
import asyncio
import os
import tempfile
from pathlib import Path

import aiohttp

import adapter as delegent


async def native_lifecycle():
    from gateway.config import GatewayConfig, PlatformConfig, Platform
    from gateway.run import GatewayRunner

    with tempfile.TemporaryDirectory(prefix='delegent-lifecycle-') as tmp:
        os.environ['HERMES_HOME'] = tmp
        os.environ['DELEGENT_PLATFORM_SECRET'] = 'local-test-only'
        os.environ['DELEGENT_PLATFORM_PORT'] = '0'
        os.environ.pop('DELEGENT_RELAY_URL', None)
        config = GatewayConfig()
        config.sessions_dir = Path(tmp) / 'sessions'
        runner = GatewayRunner(config)
        adapter = delegent.DelegentAdapter(PlatformConfig())
        runner.adapters[Platform('delegent')] = adapter
        runner._is_user_authorized = lambda source: True
        runner._read_user_config = lambda: {'approvals': {'destructive_slash_confirm': True}}
        adapter.set_message_handler(runner._handle_message)
        started = asyncio.Event()
        release = asyncio.Event()
        interrupted = []
        relayed = []

        class ModelBoundary:
            def get_activity_summary(self):
                return {'seconds_since_activity': 0}

            def interrupt(self, reason):
                interrupted.append(reason)

        async def model(**kwargs):
            runner._running_agents[kwargs['session_key']] = ModelBoundary()
            await adapter.send('owner', 'before stop')
            started.set()
            await release.wait()
            return {'final_response': 'after release', 'messages': []}

        async def relay(payload):
            relayed.append(payload)
            return True

        runner._run_agent = model
        adapter._relay = relay
        await adapter.connect()
        port = adapter._site._server.sockets[0].getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        headers = {'x-delegent-platform-secret': 'local-test-only'}
        try:
            async with aiohttp.ClientSession(headers=headers) as client:
                response = await client.post(url + '/message', json={
                    'user_id': 'owner', 'run_id': 'run_first', 'message_id': 'first', 'text': 'local test',
                })
                assert response.status == 200, await response.text()
                await asyncio.wait_for(started.wait(), 8)
                assert any(p.get('text') == 'before stop' and p['run_id'] == 'run_first' for p in relayed)

                response = await client.post(url + '/message', json={
                    'user_id': 'owner', 'run_id': 'run_overlap', 'message_id': 'second', 'text': 'unrelated request',
                })
                assert response.status == 409, await response.text()
                assert adapter._active_turns['owner'].run_id == 'run_first'

                response = await client.post(url + '/control', json={
                    'user_id': 'owner', 'action': 'stop', 'run_id': 'wrong-run',
                })
                assert response.status == 409
                assert not interrupted

                response = await client.post(url + '/control', json={
                    'user_id': 'owner', 'action': 'stop', 'run_id': 'run_first',
                })
                assert response.status == 200, await response.text()
                assert interrupted, 'native agent interruption must happen before acknowledging stop'
                assert any(p['kind'] == 'done' and p['outcome'] == 'cancelled' and p['run_id'] == 'run_first' for p in relayed), relayed
                assert not adapter._session_tasks
                assert not runner._running_agents

                key = 'agent:main:delegent:dm:owner'
                before = runner.session_store.peek_session_id(key)
                response = await client.post(url + '/control', json={'user_id': 'owner', 'action': 'reset'})
                assert response.status == 409
                assert runner.session_store.peek_session_id(key) == before
                response = await client.post(url + '/control', json={
                    'user_id': 'owner', 'action': 'reset', 'confirmed': True,
                })
                assert response.status == 200, await response.text()
                after = runner.session_store.peek_session_id(key)
                assert after and after != before
                from tools import slash_confirm
                assert slash_confirm.get_pending(key) is None
                assert not any(p.get('run_id') == 'run_overlap' for p in relayed)
                print('OK native lifecycle: actual overlap rejection, interruption, task cancellation and confirmed durable reset')
        finally:
            release.set()
            await adapter.disconnect()
            db = getattr(runner.session_store, '_db', None)
            if db and hasattr(db, 'close'):
                db.close()
            if runner._session_db:
                await runner._session_db.close()


if __name__ == '__main__':
    asyncio.run(native_lifecycle())
