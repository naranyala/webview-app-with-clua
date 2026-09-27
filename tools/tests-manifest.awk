# Generates the Makefile's C-test rules from tests/MANIFEST.
#
# Make's $(eval) inside $(call) cannot see the call's own arguments, and a
# hand-maintained rule per suite is exactly the duplication TODO-052 removed.
# So the manifest is turned into real make syntax once, here, and the Makefile
# includes the result: readable rules, `make -n` output you can trust, and one
# place to change when a suite is added.
#
# Input row:  profile | name | source [source ...]
# Output:     one build rule, one run target, and one sanitized target per row,
#             plus the SUITE_BINS / SUITE_TARGETS / SUITE_SANITIZED lists.

function profile_cflags(profile) {
  if (profile == "core") return ""
  if (profile == "glib") return "$(GLIB_CFLAGS)"
  if (profile == "glib-math") return "$(GLIB_CFLAGS)"
  if (profile == "gtk-stub") return "$(GTK_CFLAGS) -Itests/stubs"
  if (profile == "pdftotext") return "$(GLIB_CFLAGS) -DPDFTOTEXT_EXECUTABLE='\"pdftotext\"'"
  printf "tests-manifest.awk: unknown profile '%s'\n", profile > "/dev/stderr"
  exit 1
}

function profile_libs(profile) {
  if (profile == "core") return "-lm"
  if (profile == "glib") return "$(GLIB_LIBS)"
  if (profile == "glib-math") return "$(GLIB_LIBS) -lm"
  if (profile == "gtk-stub") return "$(GTK_LIBS)"
  if (profile == "pdftotext") return "$(GLIB_LIBS)"
  printf "tests-manifest.awk: unknown profile '%s'\n", profile > "/dev/stderr"
  exit 1
}

function profile_order(profile) {
  # Only the pdf-toc suite shells out to an external tool.
  return profile == "pdftotext" ? "| check-pdftotext" : ""
}

BEGIN { print "# Generated from tests/MANIFEST by tools/tests-manifest.awk. Do not edit." }

# Strip comments, then split each row on the pipes.
{
  sub(/#.*/, "")
  gsub(/^[ \t]+|[ \t]+$/, "")
  if ($0 == "") next
  n = split($0, field, /[ \t]*\|[ \t]*/)
  if (n < 3) {
    printf "tests-manifest.awk: malformed row: %s\n", $0 > "/dev/stderr"
    exit 1
  }
  profile = field[1]
  name = field[2]
  sources = field[3]
  for (i = 4; i <= n; i++) sources = sources " " field[i]

  binary = "$(BUILD)/test_" name
  bins = bins " " binary
  targets = targets " " name "-test"
  sanitized = sanitized " " name "-sanitized"

  print ""
  print "# " profile ": " name
  print binary ": " sources " $(TEST_HEADERS) " profile_order(profile)
  print "\t@mkdir -p $(dir $@)"
  print "\t$(CC) $(CFLAGS) " profile_cflags(profile) " -o $@ " sources " " profile_libs(profile)
  print ""
  print name "-test: " binary
  print "\t$<"
  print ""
  print name "-sanitized:"
  print "\t@mkdir -p $(BUILD)/sanitized"
  print "\t$(SANITIZER_CC) $(CFLAGS) " profile_cflags(profile) " $(SANITIZER_FLAGS) -o $(BUILD)/sanitized/test_" name " " sources " " profile_libs(profile)
  print "\tASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_" name
}

END {
  print ""
  print "SUITE_BINS :=" bins
  print "SUITE_TARGETS :=" targets
  print "SUITE_SANITIZED :=" sanitized
  print ".PHONY: $(SUITE_TARGETS) $(SUITE_SANITIZED)"
}
