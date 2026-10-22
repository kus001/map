"""Reading cache files written before the transit modules moved into this package.

The committed ``transit_data/*.pkl`` caches were pickled while these modules lived at
``helpers._transit`` (e.g. ``helpers._transit.make_graph.Graph``), and a pickle stores the
module path of every class it contains. ``load_cache`` maps those old paths to
``transit.*`` so the existing caches keep loading without being rebuilt.
Caches written from now on record the new ``transit.*`` paths.
"""

import pickle

_OLD_PREFIX = "helpers._transit."


class _CompatUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith(_OLD_PREFIX):
            module = "transit." + module[len(_OLD_PREFIX):]
        return super().find_class(module, name)


def load_cache(file):
    """Like ``pickle.load(file)``, understanding the pre-move ``helpers._transit`` class paths."""
    return _CompatUnpickler(file).load()
