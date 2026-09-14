#include "engine.hpp"
#include "vfs.hpp"

#include <iostream>
#include <string>
#include <vector>

int main() {
    std::cout << "=== WebDB Engine CLI (Native Build) ===" << std::endl;

    auto engine = webdb::SqlEngine();

    const std::vector<std::string> sample_queries = {
        "SELECT * FROM users;",
        "INSERT INTO users (id, name, role) VALUES (4, 'Diana', 'Lead');",
        "UPDATE users SET role = 'Senior' WHERE id = 2;",
        "DELETE FROM users WHERE id = 3;",
        "CREATE TABLE test (id INT);",
        "UNKNOWN STATEMENT;"
    };

    for (const auto& q : sample_queries) {
        std::cout << "\n[SQL] " << q << std::endl;
        const std::string result = engine.execute_query(q);
        std::cout << "[JSON Result] " << result << std::endl;
    }

    // Verify VFS in-memory storage integration
    std::cout << "\n=== Testing VFS Subsystem ===" << std::endl;
    auto vfs = engine.get_vfs();
    const std::string test_file = "test_page.bin";

    auto handle = vfs->open(test_file, webdb::vfs::OpenMode::Create | webdb::vfs::OpenMode::ReadWrite);
    if (handle != webdb::vfs::INVALID_FILE_HANDLE) {
        const std::string payload = "PAGE_HEADER_001_DATA_PAYLOAD";
        vfs->write(handle, payload.data(), payload.size(), 0);

        std::vector<char> read_buf(payload.size());
        vfs->read(handle, read_buf.data(), read_buf.size(), 0);
        std::string recovered(read_buf.begin(), read_buf.end());

        std::cout << "VFS Write & Readback: " << (recovered == payload ? "PASS" : "FAIL") << std::endl;
        std::cout << "VFS File Size: " << vfs->get_size(handle) << " bytes" << std::endl;
        vfs->close(handle);
    } else {
        std::cout << "VFS Open Failed!" << std::endl;
    }

    std::cout << "\nBaseline engine execution completed successfully." << std::endl;
    return 0;
}
