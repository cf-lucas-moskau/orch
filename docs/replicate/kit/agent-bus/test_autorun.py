"""bus-autorun's scanner rejects malformed envelopes and keeps going. Run: python3 -B test_autorun.py"""
import atexit, importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="bus-test-")
atexit.register(shutil.rmtree, TMP, True)
os.environ.update(AGENT_BUS_ROOT=os.path.join(TMP, "root"), AGENT_BUS_STATE=os.path.join(TMP, "state"),
                  AGENT_BUS_CONF=os.path.join(TMP, "beta"), AGENT_BUS_ME="beta")


def load(name):
    loader = importlib.machinery.SourceFileLoader(name, os.path.join(HERE, name))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(mod)
    return mod


autorun = load("bus-autorun")
autorun.notify = lambda *a: None
autorun.log = lambda *a: None
bus = autorun.bus
BUS = os.path.join(HERE, "bus")


def as_alpha(*args):
    env = dict(os.environ, AGENT_BUS_CONF=os.path.join(TMP, "alpha"), AGENT_BUS_ME="alpha")
    return subprocess.run([sys.executable, "-B", BUS, *args], env=env, capture_output=True, text=True, check=True).stdout.strip()


class Scan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        alpha_pub = as_alpha("keygen")
        bus.keygen()
        bus.trust(alpha_pub)  # beta now enforces signatures

    def inbox(self):
        return bus.box("inbox", "beta")

    def drop(self, name, content):
        with open(os.path.join(self.inbox(), name), "w") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))

    def test_rejects_malformed_and_keeps_valid(self):
        good = as_alpha("send", "beta", "hello", "please do x")
        bad_files = {
            "20261114-111111-aaaaaa.json": {"sig": "garbage"},                        # no from: used to crash verify()
            "20261114-111111-bbbbbb.json": {"id": "../../x", "from": "alpha", "to": "beta", "subject": "s", "body": "b"},
            "20261114-111111-cccccc.json": {"id": "20261114-111111-dddddd", "from": "alpha", "to": "beta", "subject": "s", "body": "b"},
            "20261114-111111-eeeeee.json": ["not", "an", "object"],
            "20261114-111111-ffffff.json": {"id": "20261114-111111-ffffff", "from": "alpha", "to": "beta",
                                            "subject": "s", "body": "b", "sig": "garbage"},  # well formed, bad signature
            "20261114-111112-aaaaaa.json": {"id": "20261114-111112-aaaaaa", "from": "alpha; rm -rf ~", "to": "beta",
                                            "subject": "s", "body": "b"},
        }
        for name, m in bad_files.items():
            self.drop(name, m)
        todo = autorun.scan("beta")
        self.assertEqual(todo, [good])
        self.assertEqual(sorted(os.listdir(self.inbox())), [good + ".json"])
        rejected = sorted(os.listdir(os.path.join(os.environ["AGENT_BUS_STATE"], "rejected")))
        self.assertEqual(rejected, sorted(bad_files))
        self.assertFalse(os.path.exists(os.path.join(TMP, "x")))

    def test_malformed_reasons(self):
        ok = {"id": "20261114-111111-abcdef", "from": "alpha", "to": "beta", "subject": "s", "body": "b"}
        self.assertIsNone(autorun.malformed("20261114-111111-abcdef.json", ok))
        self.assertEqual(autorun.malformed("x.json", ok), "id does not match file name")
        self.assertEqual(autorun.malformed("20261114-111111-abcdef.json", {**ok, "body": None}), "missing body")
        self.assertEqual(autorun.malformed("20261114-111111-abcdef.json", {**ok, "reply_to": "../x"}), "bad reply_to")


if __name__ == "__main__":
    unittest.main(verbosity=1)
