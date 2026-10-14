import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import routes.cookbook_routes as cookbook_routes
import core.database as database
import src.settings as settings
from routes.cookbook_helpers import _validate_serve_cmd
from src.tools import cookbook as cookbook_tools


@pytest.mark.parametrize(
    "command",
    [
        "sd-server -m /models/checkpoint.safetensors --listen-port 8100 --backend cpu",
        "sd-server-vulkan -m /models/checkpoint.safetensors --listen-port=8101 --backend diffusion=vulkan0",
        "CUDA_VISIBLE_DEVICES=0 sd-server --listen-ip 127.0.0.1 --listen-port 1234",
    ],
)
def test_stable_diffusion_cpp_commands_are_allowed_and_classified(command):
    assert _validate_serve_cmd(command) == command
    assert cookbook_routes._is_stable_diffusion_cpp_command(command)
    assert cookbook_routes._is_image_server_command(command)


def test_stable_diffusion_cpp_endpoint_uses_listen_port_and_stable_owned_id():
    command = "sd-server -m /models/sd.safetensors --listen-port 8100"
    url, endpoint_id = cookbook_routes._stable_diffusion_cpp_endpoint(command)
    assert url == "http://localhost:8100/v1"
    assert endpoint_id == cookbook_routes._stable_diffusion_cpp_endpoint(command)[1]
    assert endpoint_id != cookbook_routes._stable_diffusion_cpp_endpoint(
        command.replace("8100", "8101")
    )[1]
    assert cookbook_routes._stable_diffusion_cpp_endpoint("sd-server")[0] == "http://localhost:1234/v1"


def test_stable_diffusion_cpp_server_uses_fixed_model_id_and_native_default_port():
    assert cookbook_routes._SD_CPP_IMAGE_MODEL_ID == "sd-cpp-local"
    assert cookbook_tools._infer_serve_port("sd-server -m model.safetensors") == 1234
    assert cookbook_tools._infer_serve_port("sd-server --listen-port 8100") == 8100


def test_missing_native_stable_diffusion_binary_has_actionable_helper_guidance():
    message = cookbook_routes._missing_binary_message("sd-server-vulkan", "local server")
    assert "scripts/build-stable-diffusion.sh vulkan <output-dir>" in message
    assert "<output-dir>/vulkan/sd-server" in message
    assert "sd-server-vulkan" in message


def test_old_stop_cleanup_preserves_new_launch_on_same_port(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    database.ModelEndpoint.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    current = {"image_model": "sd-cpp-local@Example (sd.cpp)"}
    monkeypatch.setattr(settings, "load_settings", lambda: dict(current))
    monkeypatch.setattr(settings, "save_settings", lambda value: current.update(value))

    command = "sd-server -m /models/example.safetensors --listen-port 8100"
    url, old_endpoint_id = cookbook_routes._stable_diffusion_cpp_endpoint(command, launch_id="serve-old1")
    _, new_endpoint_id = cookbook_routes._stable_diffusion_cpp_endpoint(command, launch_id="serve-new1")
    assert old_endpoint_id != new_endpoint_id
    with sessions() as db:
        db.add(database.ModelEndpoint(
            id=old_endpoint_id,
            name="Example (sd.cpp)",
            base_url=url,
            model_type="image",
        ))
        db.add(database.ModelEndpoint(
            id=new_endpoint_id,
            name="Example (sd.cpp)",
            base_url=url,
            model_type="image",
        ))
        db.commit()

    cookbook_routes._delete_stable_diffusion_cpp_endpoint(command, launch_id="serve-old1")

    with sessions() as db:
        assert db.query(database.ModelEndpoint).filter_by(id=old_endpoint_id).first() is None
        assert db.query(database.ModelEndpoint).filter_by(id=new_endpoint_id).first() is not None
    assert current["image_model"] == "sd-cpp-local@Example (sd.cpp)"

    cookbook_routes._delete_stable_diffusion_cpp_endpoint(command, launch_id="serve-new1")
    assert current["image_model"] == ""


@pytest.mark.parametrize(
    ("configured_model", "expected_model"),
    [
        ("Flux-Cloud@OpenRouter", "Flux-Cloud@OpenRouter"),
        ("sd-cpp-local@Bird (sd.cpp dead1)", ""),
    ],
)
def test_early_crash_cleanup_preserves_cloud_default_and_clears_owned_default(
    monkeypatch, configured_model, expected_model
):
    engine = create_engine("sqlite:///:memory:")
    database.ModelEndpoint.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    current = {"image_model": configured_model}
    monkeypatch.setattr(settings, "load_settings", lambda: dict(current))
    monkeypatch.setattr(settings, "save_settings", lambda value: current.update(value))

    command = "sd-server -m /models/bird.safetensors --listen-port 8100"
    launch_id = "serve-dead1"
    url, endpoint_id = cookbook_routes._stable_diffusion_cpp_endpoint(command, launch_id=launch_id)
    with sessions() as db:
        db.add(database.ModelEndpoint(
            id=endpoint_id,
            name="Bird (sd.cpp dead1)",
            base_url=url,
            model_type="image",
        ))
        db.commit()

    # The early-crash watchdog calls this same launch-scoped cleanup path.
    cookbook_routes._delete_stable_diffusion_cpp_endpoint(
        command, launch_id=launch_id, endpoint_id=endpoint_id
    )
    assert current["image_model"] == expected_model


@pytest.mark.parametrize(
    ("configured_model", "expected_model"),
    [
        ("Flux-Cloud@OpenRouter", "Flux-Cloud@OpenRouter"),
        ("sd-cpp-local@Bird (sd.cpp dead1)", ""),
    ],
)
def test_early_crash_cleanup_preserves_cloud_default_and_clears_owned_default(
    monkeypatch, configured_model, expected_model
):
    engine = create_engine("sqlite:///:memory:")
    database.ModelEndpoint.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    current = {"image_model": configured_model}
    monkeypatch.setattr(settings, "load_settings", lambda: dict(current))
    monkeypatch.setattr(settings, "save_settings", lambda value: current.update(value))

    command = "sd-server -m /models/bird.safetensors --listen-port 8100"
    launch_id = "serve-dead1"
    url, endpoint_id = cookbook_routes._stable_diffusion_cpp_endpoint(command, launch_id=launch_id)
    with sessions() as db:
        db.add(database.ModelEndpoint(
            id=endpoint_id,
            name="Bird (sd.cpp dead1)",
            base_url=url,
            model_type="image",
        ))
        db.commit()

    # The early-crash watchdog calls this same launch-scoped cleanup path.
    cookbook_routes._delete_stable_diffusion_cpp_endpoint(
        command, launch_id=launch_id, endpoint_id=endpoint_id
    )
    assert current["image_model"] == expected_model
