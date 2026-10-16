from pathlib import Path
from tests.helpers.stylesheets import app_css


ROOT = Path(__file__).resolve().parents[1]


def test_image_settings_route_by_provider_and_preserve_saved_model():
    # The image panel moved into static/js/settings/imageModels.js; read the
    # whole settings surface so this pins behaviour rather than a filename.
    settings = "\n".join(
        p.read_text(encoding="utf-8")
        for p in [ROOT / "static/js/settings.js", *sorted((ROOT / "static/js/settings").glob("*.js"))]
    )

    assert "fetch('/api/model-endpoints'" in settings
    image_settings = (ROOT / 'static/js/settings/imageModels.js').read_text(encoding='utf-8')
    assert "if (!ep || !ep.is_enabled || !ep.name) return" in image_settings
    assert "String(ep.model_type || '').toLowerCase() === 'image'" in image_settings
    # Provider-qualified values keep duplicate model names unambiguous and
    # the saved choice remains visible when its endpoint is temporarily absent.
    assert "mid + '@' + ep.name" in image_settings
    assert "saved; not listed" in image_settings
    assert "_imageSaveQueue = _imageSaveQueue.then(save, save)" in image_settings


def test_deep_research_fields_are_constrained_to_their_card():
    styles = app_css()

    rule = styles[styles.index("/* Deep Research uses long labels"):]
    assert ".admin-card:has(#set-researchSearch) .settings-row { min-width: 0; }" in rule
    assert "min-width: 0 !important;" in rule
    assert "flex: 1 1 0 !important;" in rule


def test_endpoint_probe_is_hidden_during_bulk_selection():
    admin = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")

    update = admin[admin.index("function _updateEndpointBulkControls()"):admin.index("function _ensureEndpointBulkControls()")]
    assert "const probeBtn = el('adm-epProbeAllBtn');" in update
    assert "probeBtn.style.display = _endpointSelectMode ? 'none' : 'inline-flex'" in update
