#include "test_support.hpp"

namespace webdb::test {
#if defined(WEBDB_TEST_CHECKSUMS)
void test_checksums();
#elif defined(WEBDB_TEST_MASTER_PAGE)
void test_master_page_dual();
#elif defined(WEBDB_TEST_SLOTTED_PAGE)
void test_slotted_page();
#elif defined(WEBDB_TEST_TUPLE)
void test_tuple_and_3vl();
#elif defined(WEBDB_TEST_TABLE_HEAP)
void test_table_heap();
#endif
} // namespace webdb::test

int main() {
    std::cout << "========================================" << std::endl;
    std::cout << "  WebDB Storage Engine Test" << std::endl;
    std::cout << "========================================" << std::endl;

#if defined(WEBDB_TEST_CHECKSUMS)
    webdb::test::test_checksums();
#elif defined(WEBDB_TEST_MASTER_PAGE)
    webdb::test::test_master_page_dual();
#elif defined(WEBDB_TEST_SLOTTED_PAGE)
    webdb::test::test_slotted_page();
#elif defined(WEBDB_TEST_TUPLE)
    webdb::test::test_tuple_and_3vl();
#elif defined(WEBDB_TEST_TABLE_HEAP)
    webdb::test::test_table_heap();
#else
#error "A WEBDB_TEST_* test selection must be defined"
#endif

    std::cout << "\nTEST PASSED" << std::endl;
    return 0;
}
