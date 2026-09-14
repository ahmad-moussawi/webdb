#pragma once

#include "common/types.hpp"
#include "storage/value.hpp"

#include <vector>
#include <string>

namespace webdb {

struct Column {
    std::string name{};
    TypeId type{TypeId::INVALID};
    bool is_nullable{false};
};

class Schema {
public:
    Schema() = default;
    explicit Schema(std::vector<Column> columns) : columns_(std::move(columns)) {}

    size_t count() const noexcept { return columns_.size(); }
    const Column& column(size_t index) const { return columns_[index]; }
    const std::vector<Column>& columns() const noexcept { return columns_; }

    bool is_valid() const noexcept {
        if (columns_.empty() || columns_.size() > MAX_COLUMNS) return false;
        for (const auto& col : columns_) {
            if (col.type != TypeId::INT && col.type != TypeId::DOUBLE && col.type != TypeId::TEXT) {
                return false;
            }
        }
        return true;
    }

private:
    std::vector<Column> columns_;
};

class Tuple {
public:
    static constexpr uint8_t FORMAT_VERSION = 1;

    Tuple() = default;

    /**
     * @brief Constructs and serializes a tuple from a list of Value scalars against a Schema.
     * Enforces UTF-8 validity, NULL zeroing, and strict type checking.
     */
    static StorageResult serialize(const std::vector<Value>& values,
                                   const Schema& schema,
                                   std::vector<uint8_t>& out_bytes) noexcept;

    /**
     * @brief Deserializes raw byte buffer into values using the provided Schema.
     * Enforces version 1, flags 0, column count, deterministic text offsets, and valid UTF-8.
     */
    static StorageResult deserialize(const uint8_t* data,
                                     size_t size,
                                     const Schema& schema,
                                     std::vector<Value>& out_values) noexcept;

    /**
     * @brief Creates a Tuple holding serialized bytes.
     */
    explicit Tuple(std::vector<uint8_t> data) noexcept : data_(std::move(data)) {}

    const uint8_t* data() const noexcept { return data_.data(); }
    size_t size() const noexcept { return data_.size(); }
    bool is_empty() const noexcept { return data_.empty(); }

private:
    std::vector<uint8_t> data_;
};

} // namespace webdb
