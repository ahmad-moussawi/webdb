#include "storage/tuple.hpp"
#include "common/endian.hpp"

#include <cstring>
#include <new>
#include <vector>

namespace webdb {

StorageResult Tuple::serialize(const std::vector<Value>& values, const Schema& schema,
                               std::vector<uint8_t>& out_bytes) noexcept {
    try {
        if (!schema.is_valid()) {
            return StorageResult::INVALID_ARGUMENT;
        }
        const size_t num_cols = schema.count();
        if (values.size() != num_cols) {
            return StorageResult::SCHEMA_MISMATCH;
        }

        const size_t null_bitmap_bytes = (num_cols + 7) / 8;
        const size_t fixed_header_size = 4 + null_bitmap_bytes + (num_cols * 8);

        // Collect and validate variable-length text payloads
        std::vector<std::string_view> text_payloads;
        text_payloads.resize(num_cols);
        size_t total_text_bytes = 0;

        for (size_t i = 0; i < num_cols; ++i) {
            const auto& col = schema.column(i);
            const auto& val = values[i];

            if (val.is_null()) {
                if (!col.is_nullable) {
                    return StorageResult::SCHEMA_MISMATCH;  // Column declared NOT NULL
                }
                if (val.type() != col.type) {
                    return StorageResult::SCHEMA_MISMATCH;
                }
                continue;
            }

            if (val.type() != col.type) {
                return StorageResult::SCHEMA_MISMATCH;
            }

            if (col.type == TypeId::TEXT) {
                const std::string& str = val.as_text();
                if (!Value::is_valid_utf8(str)) {
                    return StorageResult::INVALID_ARGUMENT;  // Reject malformed UTF-8 on input
                }
                text_payloads[i] = str;
                total_text_bytes += str.size();
            }
        }

        const size_t total_tuple_size = fixed_header_size + total_text_bytes;
        if (total_tuple_size > MAX_TUPLE_SIZE) {
            return StorageResult::TUPLE_TOO_LARGE;
        }

        out_bytes.assign(total_tuple_size, 0);
        uint8_t* p = out_bytes.data();

        // 1. Header: format_version (1B), flags (1B), num_columns (2B)
        p[0] = FORMAT_VERSION;
        p[1] = 0;  // Flags must be 0 in Phase 1
        endian::write_uint16(p + 2, static_cast<uint16_t>(num_cols));

        // 2. NullBitmap
        uint8_t* bitmap = p + 4;
        for (size_t i = 0; i < num_cols; ++i) {
            if (values[i].is_null()) {
                bitmap[i / 8] |= static_cast<uint8_t>(1u << (i % 8));
            }
        }

        // 3. Fixed-width fields & text payload copying
        uint8_t* fixed_array = p + 4 + null_bitmap_bytes;
        uint8_t* text_cursor = p + fixed_header_size;
        uint32_t running_var_offset = 0;

        for (size_t i = 0; i < num_cols; ++i) {
            uint8_t* slot = fixed_array + (i * 8);
            const auto& val = values[i];

            if (val.is_null()) {
                // Null fields: both fixed 8 bytes and text space MUST be zeroed
                std::memset(slot, 0, 8);
                continue;
            }

            const auto& col = schema.column(i);
            if (col.type == TypeId::INT) {
                endian::write_int64(slot, val.as_int());
            } else if (col.type == TypeId::DOUBLE) {
                endian::write_double(slot, val.as_double());
            } else if (col.type == TypeId::TEXT) {
                const auto text_view = text_payloads[i];
                const auto len = static_cast<uint32_t>(text_view.size());
                endian::write_uint32(slot, running_var_offset);
                endian::write_uint32(slot + 4, len);

                if (len > 0) {
                    std::memcpy(text_cursor, text_view.data(), len);
                    text_cursor += len;
                    running_var_offset += len;
                }
            }
        }

        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

StorageResult Tuple::deserialize(const uint8_t* data, size_t size, const Schema& schema,
                                 std::vector<Value>& out_values) noexcept {
    try {
        if (!data || !schema.is_valid()) {
            return StorageResult::INVALID_ARGUMENT;
        }
        if (size > MAX_TUPLE_SIZE) {
            return StorageResult::TUPLE_TOO_LARGE;
        }
        if (size < 4) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 1. Format version and flags validation
        const uint8_t version = data[0];
        if (version != FORMAT_VERSION) {
            return StorageResult::VERSION_MISMATCH;
        }

        const uint8_t flags = data[1];
        if (flags != 0) {
            return StorageResult::CORRUPTED_PAGE;  // Nonzero flags invalid in Phase 1
        }

        // 2. Column count check
        const uint16_t serialized_cols = endian::read_uint16(data + 2);
        const size_t num_cols = schema.count();
        if (serialized_cols != num_cols) {
            return StorageResult::SCHEMA_MISMATCH;
        }

        const size_t null_bitmap_bytes = (num_cols + 7) / 8;
        const size_t min_fixed_size = 4 + null_bitmap_bytes + (num_cols * 8);

        if (size < min_fixed_size) {
            return StorageResult::CORRUPTED_PAGE;
        }

        const uint8_t* bitmap = data + 4;
        const uint8_t* fixed_array = data + 4 + null_bitmap_bytes;
        const uint8_t* var_payload_start = data + min_fixed_size;
        const size_t total_var_length = size - min_fixed_size;

        out_values.clear();
        out_values.reserve(num_cols);

        uint32_t expected_running_offset = 0;

        for (size_t i = 0; i < num_cols; ++i) {
            const auto& col = schema.column(i);
            const uint8_t* slot = fixed_array + (i * 8);

            const bool is_null = (bitmap[i / 8] & (1u << (i % 8))) != 0;
            if (is_null) {
                if (!col.is_nullable) {
                    return StorageResult::SCHEMA_MISMATCH;  // NULL in non-nullable column
                }
                // Check that the fixed 8 bytes are zeroed
                uint64_t zero_check = endian::read_uint64(slot);
                if (zero_check != 0) {
                    return StorageResult::CORRUPTED_PAGE;
                }
                out_values.push_back(Value::make_null(col.type));
                continue;
            }

            if (col.type == TypeId::INT) {
                const int64_t val = endian::read_int64(slot);
                out_values.push_back(Value::make_int(val));
            } else if (col.type == TypeId::DOUBLE) {
                const double val = endian::read_double(slot);
                out_values.push_back(Value::make_double(val));
            } else if (col.type == TypeId::TEXT) {
                const uint32_t var_offset = endian::read_uint32(slot);
                const uint32_t var_len = endian::read_uint32(slot + 4);

                // Deterministic cursor rule: text ranges must be tightly packed in ascending order
                if (var_offset != expected_running_offset) {
                    return StorageResult::CORRUPTED_PAGE;  // Non-monotonic, overlapping, or gap
                }

                if (static_cast<uint64_t>(var_offset) + var_len > total_var_length) {
                    return StorageResult::CORRUPTED_PAGE;  // Out of bounds
                }

                std::string text_str(reinterpret_cast<const char*>(var_payload_start + var_offset), var_len);
                if (!Value::is_valid_utf8(text_str)) {
                    return StorageResult::CORRUPTED_PAGE;  // Persisted malformed UTF-8
                }

                expected_running_offset += var_len;
                out_values.push_back(Value::make_text(std::move(text_str)));
            }
        }

        // Verify trailing unused text space: running offset must match total_var_length exactly
        if (expected_running_offset != total_var_length) {
            return StorageResult::CORRUPTED_PAGE;
        }

        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

}  // namespace webdb
