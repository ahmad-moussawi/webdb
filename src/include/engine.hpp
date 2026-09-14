#pragma once

#include "vfs.hpp"
#include <memory>
#include <string>

namespace webdb {

/**
 * @brief Core relational SQL database engine.
 *
 * Implements the database execution lifecycle, coordinating the storage engine
 * via the Virtual File System (VFS), query parsing, and execution.
 *
 * Designed to be strictly single-threaded and portable across WASM and native targets.
 */
class SqlEngine {
public:
    /**
     * @brief Constructs an instance of the database engine.
     * @param vfs Optional custom virtual filesystem. If nullptr, an InMemoryFileSystem is used.
     */
    explicit SqlEngine(std::shared_ptr<vfs::IVirtualFileSystem> vfs = nullptr);

    ~SqlEngine() = default;

    // Disallow copy semantics to protect engine and handle ownership
    SqlEngine(const SqlEngine&) = delete;
    SqlEngine& operator=(const SqlEngine&) = delete;

    // Allow move semantics
    SqlEngine(SqlEngine&&) noexcept = default;
    SqlEngine& operator=(SqlEngine&&) noexcept = default;

    /**
     * @brief Executes a raw SQL query string and returns the result as a standardized JSON string.
     *
     * In this baseline milestone, crude string matching is applied to simulate query execution:
     * - SELECT queries return tabular mock row data with schema metadata.
     * - INSERT / UPDATE / DELETE / CREATE queries return mutation status and row counts.
     * - Unrecognized queries return an error envelope with details.
     *
     * @param query SQL query string to be parsed and evaluated.
     * @return Formatted JSON string containing execution results or error details.
     */
    std::string execute_query(const std::string& query);

    /**
     * @brief Access the underlying Virtual File System.
     * @return Shared pointer to the VFS instance.
     */
    [[nodiscard]] std::shared_ptr<vfs::IVirtualFileSystem> get_vfs() const noexcept;

private:
    std::shared_ptr<vfs::IVirtualFileSystem> vfs_;
};

} // namespace webdb
