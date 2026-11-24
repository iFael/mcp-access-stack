"""Linux-only unit tests. No sudo, package installation, or systemd calls."""
import hashlib
import importlib.util
import re
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("apt_maintenance", Path(__file__).with_name("oracle-apt-maintenance.py"))
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)

MODULE = "linux-modules-7.0.0-1013-oracle"
IMAGE = "linux-image-7.0.0-1013-oracle"
VERSION = "7.0.0-1013.13~24.04.1"
FIX = f"Inst {MODULE} ({VERSION} Ubuntu [amd64])\nConf {MODULE} ({VERSION} Ubuntu [amd64])\nConf {IMAGE} ({VERSION} Ubuntu [amd64])\n"
ID = "11111111-2222-4333-8444-555555555555"
SECOND = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


class Fake:
    def __init__(self):
        self.output = FIX
        self.image_version = VERSION
        self.clean = False
        self.installed_libraries = False
        self.dispatched = []
        self.mutations = []
        self.dispatch_code = 0
        self.apply_code = 0
        self.postcheck_clean = True
        self.active = True

    def run(self, args, *, mutate=False):
        def result(code=0, output=""):
            return SimpleNamespace(returncode=code, stdout=output)
        if args[0] == apt.QUERY:
            if args[-1] == IMAGE:
                return result(output="iU  " + self.image_version)
            return result(output="ii  1.0") if self.installed_libraries else result(1)
        if args[0] == apt.DPKG:
            return result(output="" if self.clean else "pending kernel")
        if args[:3] == [apt.APT, "-s", "check"]:
            return result(0 if self.clean else 100)
        if args[0] == "/usr/bin/systemd-run":
            self.dispatched.append(args)
            return result(self.dispatch_code)
        if args[0] == "/usr/bin/systemctl":
            return result(output="active" if self.active else "inactive")
        if args[0] == apt.APT and "-s" in args:
            return result(output=self.output)
        if args[0] == apt.APT and mutate:
            self.mutations.append(args)
            if self.apply_code == 0:
                self.clean = self.postcheck_clean
                self.installed_libraries = all(name in args for name in apt.LIBRARIES)
                self.output = ""
            return result(self.apply_code)
        raise AssertionError(f"Unexpected call: {args}")


class Tests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        state = Path(self.directory.name)
        self.dpkg_status = state / "dpkg-status"
        self.dpkg_status.write_text("initial state", encoding="utf-8")
        self.fake = Fake()
        self.service = apt.Maintenance(state, self.fake.run, self.dpkg_status)

    def plan(self, operation=apt.REPAIR):
        return self.service.handle({"workspaceId": apt.WORKSPACE, "action": "plan", "operation": operation})

    def apply(self, plan, operation_id=ID):
        return self.service.handle({"workspaceId": apt.WORKSPACE, "action": "apply",
            "operation": plan["operation"], "expectedPlanSha256": plan["planSha256"], "operationId": operation_id})

    def status(self, operation_id=ID):
        return self.service.handle({"workspaceId": apt.WORKSPACE, "action": "status", "operationId": operation_id})

    def test_admin_installer_pins_module_and_exact_sudo_scope(self):
        module = Path(__file__).with_name("oracle-apt-maintenance.py")
        installer = module.parent.parent / "deploy/linux/Install-McpV3AptMaintenancePolicy.sh"
        source = installer.read_text(encoding="utf-8")
        digest = hashlib.sha256(module.read_bytes()).hexdigest()
        self.assertIn('expected_sha="' + digest + '"', source)
        self.assertIn('NOPASSWD: NOSETENV: /usr/local/libexec/mcp-v3-apt-maintenance ""', source)
        self.assertNotRegex(source, r"NOPASSWD:\s*(?:NOSETENV:\s*)?ALL")
        self.assertIn('Host root and no arguments required.', source)
        self.assertIn('python3 -I -B /usr/local/libexec/mcp-v3-apt-maintenance.py', source)

    def test_rejects_untrusted_request_fields(self):
        base = {"workspaceId": apt.WORKSPACE, "action": "plan", "operation": apt.REPAIR}
        for invalid in [{**base, "command": "anything"}, {**base, "packages": ["anything"]},
                        {**base, "workspaceId": "other"}, {**base, "operation": "upgrade"},
                        {"workspaceId": apt.WORKSPACE, "action": "status", "operationId": "../etc"}]:
            with self.assertRaises(ValueError):
                self.service.handle(invalid)
        self.assertEqual(self.fake.mutations, [])
        self.assertEqual(self.fake.dispatched, [])

    def test_refuses_removal_upgrade_unrelated_package_and_mismatched_kernel(self):
        for unsafe in [f"Remv {IMAGE} [{VERSION}]\n", f"Inst {MODULE} [1] ({VERSION} Ubuntu)\n",
                       "Inst openssh-server (1 Ubuntu)\n", "Conf arbitrary-service (1 Ubuntu)\n"]:
            self.fake.output = unsafe
            self.assertEqual(self.plan()["diagnostic"], "unsafe_plan")
        self.fake.output = FIX
        self.fake.image_version = "7.0.0-9999"
        self.assertEqual(self.plan()["diagnostic"], "unsafe_plan")
        self.assertEqual(self.fake.dispatched, [])

    def test_plan_binds_dpkg_state_and_rechecks_before_dispatch(self):
        plan = self.plan()
        self.assertEqual(plan["status"], "ready")
        self.assertEqual(len(plan["changes"]), 3)
        self.dpkg_status.write_text("changed state", encoding="utf-8")
        self.assertEqual(self.apply(plan)["status"], "plan_changed")
        self.assertEqual(self.fake.dispatched, [])
        self.assertEqual(self.fake.mutations, [])

    def test_idempotent_dispatch_and_worker_postcheck(self):
        plan = self.plan()
        self.assertEqual(self.apply(plan)["status"], "running")
        self.assertEqual(self.apply(plan)["status"], "running")
        self.assertEqual(len(self.fake.dispatched), 1)
        self.assertEqual(self.apply({**plan, "planSha256": "b" * 64})["status"], "operation_conflict")
        self.assertEqual(self.apply(plan, SECOND)["diagnostic"], "another_operation_active")
        self.service.worker(ID)
        self.assertEqual(self.status()["status"], "succeeded")
        self.assertEqual(self.apply(plan)["status"], "succeeded")
        self.assertEqual(len(self.fake.mutations), 1)
        command = self.fake.mutations[0]
        self.assertIn(MODULE + "=" + VERSION, command)
        self.assertIn("--no-remove", command)
        self.assertIn("--no-upgrade", command)
        self.assertNotIn("upgrade", command)
        with self.assertRaises(ValueError):
            self.service.worker(ID)

    def test_worker_rechecks_plan_after_dispatch(self):
        self.apply(self.plan())
        self.dpkg_status.write_text("changed after dispatch", encoding="utf-8")
        self.service.worker(ID)
        self.assertEqual(self.status()["diagnostic"], "plan_changed")
        self.assertEqual(self.fake.mutations, [])

    def test_lost_dispatch_receipt_is_never_replayed(self):
        plan = self.plan()
        self.fake.dispatch_code = 1
        self.assertEqual(self.apply(plan)["status"], "outcome_unknown")
        record = self.service.read(ID)
        record["createdAt"] = time.time() - 60
        self.service.save(record)
        self.fake.active = False
        self.assertEqual(self.status()["status"], "outcome_unknown")
        self.assertEqual(self.apply(plan)["status"], "outcome_unknown")
        self.assertEqual(self.apply(plan, SECOND)["diagnostic"], "another_operation_active")
        self.assertEqual(len(self.fake.dispatched), 1)

    def test_failed_apt_or_failed_postcheck_never_reports_success(self):
        plan = self.plan()
        self.apply(plan)
        self.fake.apply_code = 100
        self.service.worker(ID)
        self.assertEqual(self.status()["diagnostic"], "apt_apply_failed")
        self.fake.apply_code = 0
        self.fake.postcheck_clean = False
        self.apply(self.plan(), SECOND)
        self.service.worker(SECOND)
        self.assertEqual(self.status(SECOND)["diagnostic"], "postcheck_failed")

    def test_browser_libraries_require_healthy_apt_and_are_fixed(self):
        self.assertEqual(self.plan(apt.BROWSER)["diagnostic"], "apt_unhealthy")
        self.fake.clean = True
        self.fake.output = "\n".join(f"Inst {name} (1.0 Ubuntu)\nConf {name} (1.0 Ubuntu)" for name in apt.LIBRARIES)
        plan = self.plan(apt.BROWSER)
        self.assertEqual(plan["status"], "ready")
        self.apply(plan)
        self.service.worker(ID)
        self.assertEqual(self.status()["status"], "succeeded")
        command = self.fake.mutations[0]
        self.assertEqual(command[-3:], list(apt.LIBRARIES))
        self.assertNotIn("--fix-broken", command)


if __name__ == "__main__":
    unittest.main()
