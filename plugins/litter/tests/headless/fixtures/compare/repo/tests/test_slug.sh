. ./lib/slug.sh
eq() { [ "$1" = "$2" ] || { echo "test_slug: got '$1', want '$2'"; exit 1; }; }
eq "$(slug 'Hello World')" hello-world
eq "$(slug '  Trim me  ')" trim-me
eq "$(slug 'v1.2_beta')" v1-2-beta
eq "$(slug 'Hello, World!')" hello-world
eq "$(slug 'a--b')" a-b
