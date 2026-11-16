import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('compression_patch', Path(__file__).parent / 'scripts' / 'patch-hermes-compression.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_patch_requires_known_native_code_and_is_idempotent():
    with pytest.raises(RuntimeError, match='Pinned Hermes'):
        module.patch('unknown new upstream implementation')
    source = '                "task": "compression",\n            message = response.choices[0].message\n'
    changed = module.patch(source)
    assert module.patch(changed) == changed
    assert '"max_tokens": 16384' in changed


def test_truncated_native_response_is_rejected_before_content_is_accepted():
    from types import SimpleNamespace
    source = '                "task": "compression",\n            message = response.choices[0].message\n'
    changed = module.patch(source)
    validation = changed[changed.index('            if getattr'):]
    import textwrap
    with pytest.raises(RuntimeError, match='truncated'):
        exec(textwrap.dedent(validation), {'response': SimpleNamespace(choices=[SimpleNamespace(finish_reason='length', message='partial')])})
    ns = {'response': SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message='complete')])}
    exec(textwrap.dedent(validation), ns)
    assert ns['message'] == 'complete'
