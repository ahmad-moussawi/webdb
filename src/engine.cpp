#include "engine.hpp"

#include <cctype>
#include <sstream>
#include <string_view>
#include <algorithm>

namespace webdb {

namespace {

/**
 * @brief Trims leading and trailing whitespace characters.
 */
std::string_view trim_whitespace(std::string_view str) {
    const auto start = str.find_first_not_of(" \t\n\r");
    if (start == std::string_view::npos) {
        return "";
    }
    const auto end = str.find_last_not_of(" \t\n\r");
    return str.substr(start, end - start + 1);
}

/**
 * @brief Converts ASCII string to uppercase for case-insensitive keyword inspection.
 */
std::string to_uppercase(std::string_view str) {
    std::string upper;
    upper.reserve(str.size());
    for (char c : str) {
        upper.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
    }
    return upper;
}

/**
 * @brief Escapes characters in a string to produce compliant JSON values.
 */
std::string json_escape(std::string_view input) {
    std::ostringstream ss;
    for (char c : input) {
        switch (c) {
            case '"':  ss << "\\\""; break;
            case '\\': ss << "\\\\"; break;
            case '\b': ss << "\\b";  break;
            case '\f': ss << "\\f";  break;
            case '\n': ss << "\\n";  break;
            case '\r': ss << "\\r";  break;
            case '\t': ss << "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Escape ASCII control characters as unicode escapes
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    ss << buf;
                } else {
                    ss << c;
                }
                break;
        }
    }
    return ss.str();
}

} // namespace

SqlEngine::SqlEngine(std::shared_ptr<vfs::IVirtualFileSystem> vfs)
    : vfs_(vfs ? std::move(vfs) : std::make_shared<vfs::InMemoryFileSystem>()) {
    // Initialize default catalog file on the virtual filesystem
    constexpr std::string_view catalog_file = "catalog.db";
    if (!vfs_->exists(std::string(catalog_file))) {
        const auto handle = vfs_->open(std::string(catalog_file), vfs::OpenMode::Create | vfs::OpenMode::Write);
        if (handle != vfs::INVALID_FILE_HANDLE) {
            constexpr uint32_t magic_header = 0x57454244; // "WEBD"
            vfs_->write(handle, &magic_header, sizeof(magic_header), 0);
            vfs_->close(handle);
        }
    }
}

std::shared_ptr<vfs::IVirtualFileSystem> SqlEngine::get_vfs() const noexcept {
    return vfs_;
}

std::string SqlEngine::execute_query(const std::string& query) {
    const std::string_view trimmed = trim_whitespace(query);

    if (trimmed.empty()) {
        return R"({"status":"error","code":"EMPTY_QUERY","message":"Query string is empty."})";
    }

    // Extract first keyword/token
    const auto first_space = trimmed.find_first_of(" \t\n\r;");
    const std::string_view first_token = trimmed.substr(0, first_space);
    const std::string keyword = to_uppercase(first_token);

    std::ostringstream response;

    if (keyword == "SELECT") {
        // Return mock tabular result with columns, types, and rows
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"SELECT",)"
                 << R"("columns":["id","name","role"],)"
                 << R"("column_types":["INTEGER","VARCHAR","VARCHAR"],)"
                 << R"("rows":[)"
                 << R"([1,"Alice","Admin"],)"
                 << R"([2,"Bob","Engineer"],)"
                 << R"([3,"Charlie","Designer"])"
                 << "],"
                 << R"("row_count":3)"
                 << "}";
    } else if (keyword == "INSERT") {
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"INSERT",)"
                 << R"("affected_rows":1,)"
                 << R"("message":"1 row inserted successfully.")"
                 << "}";
    } else if (keyword == "UPDATE") {
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"UPDATE",)"
                 << R"("affected_rows":2,)"
                 << R"("message":"2 rows updated successfully.")"
                 << "}";
    } else if (keyword == "DELETE") {
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"DELETE",)"
                 << R"("affected_rows":1,)"
                 << R"("message":"1 row deleted successfully.")"
                 << "}";
    } else if (keyword == "CREATE") {
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"CREATE",)"
                 << R"("message":"Schema object created successfully.")"
                 << "}";
    } else if (keyword == "DROP") {
        response << "{"
                 << R"("status":"success",)"
                 << R"("type":"DROP",)"
                 << R"("message":"Schema object dropped successfully.")"
                 << "}";
    } else {
        response << "{"
                 << R"("status":"error",)"
                 << R"("code":"SYNTAX_ERROR",)"
                 << R"("message":"Unsupported or invalid SQL statement keyword ')"
                 << json_escape(first_token)
                 << R"('",)"
                 << R"("query":")"
                 << json_escape(trimmed)
                 << R"(")"
                 << "}";
    }

    return response.str();
}

} // namespace webdb
