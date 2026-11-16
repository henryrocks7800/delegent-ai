"""Run the patched, pinned compressor through its real failure/success paths."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch


def native_compression():
    from agent.context_compressor import ContextCompressor
    messages = [{'role': 'system', 'content': 'Remember the project records.'}]
    messages += [{'role': 'user' if i % 2 == 0 else 'assistant',
                  'content': f'Project {i}: ' + ('verified project detail ' * 120)} for i in range(120)]
    original = deepcopy(messages)
    for finish in ('length', 'stop'):
        compressor = ContextCompressor(
            model='openai/gpt-5.6-luna', threshold_percent=0.12,
            config_context_length=1_050_000, quiet_mode=True,
            abort_on_summary_failure=True,
        )
        # Keep the fixture offline. The boundary returns exactly the provider's
        # response shape, including the truncation flag that production lost.
        response = SimpleNamespace(choices=[SimpleNamespace(
            finish_reason=finish, message=SimpleNamespace(content='## Active Task\nReview project records.\n## Completed Actions\nRecords read.'),
        )])
        with patch('agent.context_compressor.call_llm', return_value=response) as call:
            result = compressor.compress(messages, current_tokens=150_000, force=True)
        assert call.called, 'the fixture must actually invoke the native summarizer'
        assert call.call_args.kwargs['max_tokens'] == 16384
        if finish == 'length':
            assert result == original, 'truncation must not discard any of the original turns'
            assert compressor._last_compress_aborted is True
            assert compressor._previous_summary is None
        else:
            assert len(result) < len(original)
            assert compressor._last_compress_aborted is False
    print('OK native compression: full summary compacts; truncated summary preserves every input turn')


if __name__ == '__main__':
    native_compression()
